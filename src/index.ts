#!/usr/bin/env node

/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as child from "child_process";
import * as cluster from "cluster";
import * as os from "os";
import * as fs from "fs";
import * as axios from "axios";
import * as minimist from "minimist";
import { ActiveNetwork, ActiveInterfaces } from "@activeledger/activenetwork";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
import Client, { CouchDoc } from "davenport";
import { DataStore } from "./datastore";

// Process Arguments
// TOOD: Change solution to static class
(global as any).argv = minimist(process.argv.slice(2));

// Do we have an identity (Will always need, Can be shared)
if (!fs.existsSync("./.identity")) {
  ActiveLogger.info("No Identity found. Generating Identity");
  let identity: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair();
  fs.writeFileSync("./.identity", JSON.stringify(identity.generate()));
  ActiveLogger.info("Identity Generated. Continue Boot Cycle");
}

// Quick Testnet builder
if ((global as any).argv.testnet) {
  ActiveLogger.info("Creating Local Testnet");

  // Hold arguments for merge
  let merge: Array<string> = [];

  // How many in the testnet
  let instances = parseInt((global as any).argv.testnet) || 3;

  // Create Local Nodes
  let processPromises: Array<Promise<any>> = [];
  for (let i = 0; i < instances; i++) {
    processPromises.push(
      new Promise((resolve, reject) => {
        ActiveLogger.info("Creating Node Instance " + i);

        // Need specific folder for each instance
        fs.mkdirSync(`instance-${i}`);

        // Copy shared identity
        fs.copyFileSync("./.identity", `instance-${i}/.identity`);

        // Instance Arguments (Start @ 5260)
        let args = [
          `--port ${5250 + (i + 1) * 10}`,
          `--data-dir .ds`,
          `--setup-only`
        ];

        // Push to Merge
        merge.push(`--merge "./instance-${i}/config.json"`);

        // Excecute
        let cprocess = child.exec(`activeledger ${args.join(" ")}`, {
          cwd: `instance-${i}`
        });

        // Wait to shutdown
        setTimeout(() => {
          ActiveLogger.info("Stopping Node Instance " + i);
          // Terminate (So we can merge)
          cprocess.kill("SIGINT");
          resolve(true);
        }, 2000);
      })
    );
  }

  // Wait on Promises
  Promise.all(processPromises)
    .then(() => {
      ActiveLogger.info("Setting up instances networking");

      // Now run merge
      let cprocess = child.exec(`activeledger ${merge.join(" ")}`);

      // Wait for exit
      cprocess.on("exit", () => {
        ActiveLogger.info("----------");
        ActiveLogger.info("Run Instances Individually");
        ActiveLogger.info("----------");

        // testnet launcher
        let testnet: string = 'let child = require("child_process");\r\n';

        // Let them know how to manually run.
        for (let i = 0; i < instances; i++) {
          let launch = `cd instance-${i} && activeledger`;

          // Print Launch Command
          ActiveLogger.info(launch);

          // Save to file
          testnet += `child.exec("${launch}");\r\n`;
        }

        // Write Testnet file
        fs.writeFileSync("testnet", testnet);

        ActiveLogger.info("----------");
        ActiveLogger.info("Run All Instances");
        ActiveLogger.info("----------");
        ActiveLogger.info("node testnet");
        process.exit();
      });
    })
    .catch(e => {
      ActiveLogger.fatal(e, "Testnet Build Failure");
      process.exit();
    });
} else {
  // Merge Configs (Helps Build local net)
  if ((global as any).argv.merge) {
    if ((global as any).argv.merge.length) {
      // Holds the object to write back
      let neighbourhood: Array<any> = [];
      // Loop array build network object up and loop again (Speed not important)
      for (let index = 0; index < (global as any).argv.merge.length; index++) {
        const configFile = (global as any).argv.merge[index];

        // Check file exists
        if (fs.existsSync(configFile)) {
          // Read File
          const config: any = JSON.parse(fs.readFileSync(configFile, "utf8"));

          // Check only 1 entry to merge
          if (config.neighbourhood.length == 1) {
            // Add to array
            neighbourhood.push(config.neighbourhood[0]);
          } else {
            ActiveLogger.fatal(
              `${configFile} has multiple entries in neighbourhood`
            );
            process.exit();
          }
        } else {
          ActiveLogger.fatal(`Configuration file "${configFile}" not found`);
          process.exit();
        }
      }

      // Loop again and write config
      for (let index = 0; index < (global as any).argv.merge.length; index++) {
        const configFile = (global as any).argv.merge[index];

        // Check file still exists
        if (fs.existsSync(configFile)) {
          // Read File
          const config: any = JSON.parse(fs.readFileSync(configFile, "utf8"));
          // Update Neighbourhood
          config.neighbourhood = neighbourhood;
          // Write File
          fs.writeFileSync(configFile, JSON.stringify(config));
        }
      }
      ActiveLogger.info("Local neighbourhood configuration has been merged");
    } else {
      ActiveLogger.fatal("Mutiple merge arguments needed to continue.");
    }
  } else {
    // Continue Normal Boot

    // Check for config
    if (!fs.existsSync((global as any).argv.config || "./config.json")) {
      // Read default config so we can add our identity to the neighbourhood
      let defConfig: any = JSON.parse(
        fs.readFileSync(__dirname + "/default.config.json", "utf8")
      );

      // Adjusting Ports (Check for default port)
      if ((global as any).argv.port && (global as any).argv.port !== 5260) {
        // Update Node Host
        defConfig.host =
          (global as any).argv.host ||
          "127.0.0.1" + ":" + (global as any).argv.port;

        // Update Self host
        defConfig.db.selfhost.port = (
          parseInt((global as any).argv.port) - 1
        ).toString();

        // Disable auto starts as they have their own port settings
        defConfig.autostart.core = false;
        defConfig.autostart.restore = false;
      }

      // Data directory passed?
      if ((global as any).argv["data-dir"]) {
        defConfig.db.selfhost.dir = (global as any).argv["data-dir"];
      }

      // Read identity (can't assume it was always created)
      let identity: any = JSON.parse(fs.readFileSync("./.identity", "utf8"));

      // Add this identity
      defConfig.neighbourhood.push({
        identity: {
          type: "rsa",
          public: identity.pub.pkcs8pem
        },
        host: (global as any).argv.host || "127.0.0.1",
        port: (global as any).argv.port || "5260"
      });

      // lets write the default one in this location
      fs.writeFileSync(
        (global as any).argv.config || "./config.json",
        JSON.stringify(defConfig)
      );
      ActiveLogger.info(
        "Created Config File - Please see documentation about network setup"
      );
    }

    // Get Config & Set as Global
    // TOOD: Change solution to static class
    (global as any).config = JSON.parse(
      fs.readFileSync((global as any).argv.config || "./config.json", "utf8")
    );

    // Add to config its file path
    (global as any).config.__filename =
      (global as any).argv.config || "./config.json";

    // Check for local contracts folder
    if (!fs.existsSync("contracts")) fs.mkdirSync("contracts");

    // Check for modules link for running contracts
    if (!fs.existsSync("contracts/node_modules"))
      fs.symlinkSync(
        `${__dirname}/../node_modules`,
        "contracts/node_modules",
        "dir"
      );

    // Move config based to merged ledger configuration
    if ((global as any).argv["assert-network"]) {
      // Make sure this node belives everyone is online
      axios.default
        .get(`http://${(global as any).config.host}/a/status`)
        .then(status => {
          // Verify the status are all home
          let neighbours = Object.keys(status.data.neighbourhood.neighbours);
          let i = neighbours.length;

          // Loop and check
          while (i--) {
            if (!status.data.neighbourhood.neighbours[neighbours[i]].isHome) {
              ActiveLogger.fatal(
                "All known nodes must been online for assertion"
              );
              process.exit();
            }
          }

          // Get Identity
          let identity: ActiveCrypto.KeyHandler = JSON.parse(
            fs.readFileSync(
              (global as any).argv.identity || "./.identity",
              "utf8"
            )
          );

          // Get Signing Object
          let signatory: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair(
            "rsa",
            identity.prv.pkcs8pem
          );

          // Build Transaction
          let assert = {
            $tx: {
              $namespace: "default",
              $contract: "setup",
              $entry: "assert",
              $i: {
                selfsign: {
                  type: "rsa",
                  publicKey: identity.pub.pkcs8pem
                },
                setup: {
                  security: (global as any).config.security,
                  consensus: (global as any).config.consensus,
                  neighbourhood: (global as any).config.neighbourhood
                }
              }
            },
            $selfsign: true,
            $sigs: {
              selfsign: "",
              [(global as any).config.host]: ""
            }
          };

          // Sign Transaction
          let signed = signatory.sign(assert.$tx);

          // Add twice to transaction
          assert.$sigs[
            (global as any).config.host
          ] = assert.$sigs.selfsign = signed;

          // Submit Transaction to self
          axios.default
            .post(`http://${(global as any).config.host}`, assert)
            .then(() => {
              ActiveLogger.info("Network Asserted to the ledger");
            })
            .catch(e => {
              ActiveLogger.fatal(
                e.response.data,
                "Networking Assertion Failed"
              );
            });
        })
        .catch(e => {
          ActiveLogger.fatal(
            e.response ? e.response.data : e,
            "Unable to assess network for assertion"
          );
        });
    } else {
      // Are we only doing setups if so stopped
      if ((global as any).argv["setup-only"]) {
        process.exit();
      }

      // TODO Move all of config into its own static class. For now build here.
      let extendConfig: Function = (boot: Function) => {
        let tmpDb = new Client(
          (global as any).config.db.url,
          (global as any).config.db.database
        );

        tmpDb
          .get((global as any).config.network)
          .then((config: any) => {
            ActiveLogger.info("Extending config from ledger");
            // Manual Configuration Merge
            (global as any).config.security = config.security;
            (global as any).config.consensus = config.consensus;
            (global as any).config.neighbourhood = config.neighbourhood;
            // continue Boot
            boot();
          })
          .catch(() => {
            ActiveLogger.warn("No network configuration found on Ledger");
            boot();
          });
      };

      // If we have a network we need to build the rest for the ledger
      if ((global as any).config.network) {
      }

      // Manage Node Cluster
      if (cluster.isMaster) {
        // Boot Function, Used to wait on self host
        let boot: Function = () => {
          // Launch as many nodes as cpus
          let cpus = os.cpus().length;
          ActiveLogger.info("Server is active, Creating forks " + cpus);

          // Create Master Home
          let activeHome: ActiveNetwork.Home = new ActiveNetwork.Home();

          // Manage Activeledger Process Sessions
          let activeSession: ActiveNetwork.Session = new ActiveNetwork.Session(
            activeHome
          );

          // Maintain Network Neighbourhood & Let Workers know
          let activeWatch = new ActiveNetwork.Maintain(
            activeHome,
            activeSession
          );

          // Loop CPUs and fork
          while (cpus--) {
            activeSession.add(cluster.fork());
          }

          // Watch for worker exit / crash and restart
          cluster.on("exit", worker => {
            ActiveLogger.debug(worker, "Worker has died, Restarting");
            let restart = activeSession.add(cluster.fork());
            // We can restart but we need to update the workers left & right & ishome
            //worker.send({type:"neighbour",})
          });

          // Auto starting other activeledger services?
          if ((global as any).config.autostart) {
            // Auto starting Core API?
            if ((global as any).config.autostart.core) {
              ActiveLogger.info("Auto starting - Core API");

              // Launch & Listen for launch error
              child
                .spawn(
                  /^win/.test(process.platform)
                    ? "activecore.cmd"
                    : "activecore",
                  [],
                  {
                    cwd: "./"
                  }
                )
                .on("error", error => {
                  ActiveLogger.error(error, "Core API Failed to start");
                });
            }

            // Auto Starting Restore Engine?
            if ((global as any).config.autostart.restore) {
              ActiveLogger.info("Auto starting - Restore Engine");
              // Launch & Listen for launch error
              child
                .spawn(
                  /^win/.test(process.platform)
                    ? "activerestore.cmd"
                    : "activerestore",
                  [],
                  {
                    cwd: "./"
                  }
                )
                .on("error", error => {
                  ActiveLogger.error(error, "Restore Engine Failed to start");
                });
            }
          }
        };

        // Self hosted data storage engine
        if ((global as any).config.db.selfhost) {
          // Create Datastore instance
          let datastore: DataStore = new DataStore();

          // Rewrite config for this process
          (global as any).config.db.url = datastore.launch();

          // Wait a bit for process to fully start
          setTimeout(() => {
            extendConfig(boot);
          }, 2000);
        } else {
          // Continue
          boot();
        }
      } else {
        // Temporary Path Solution
        (global as any).__base = __dirname;

        // Self hosted data storage engine
        if ((global as any).config.db.selfhost) {
          // Rewrite config for this process
          (global as any).config.db.url =
            "http://localhost:" + (global as any).config.db.selfhost.port;
        }

        extendConfig(() => {
          // Create Home Host Node
          let activeHost = new ActiveNetwork.Host();
        });
      }
    }
  }
}
