//Requires
const modulename = 'FXRunner';
const { spawn } = require('child_process');
const path = require('path');
const sleep = require('util').promisify((a, f) => setTimeout(f, a));
const { parseArgsStringToArgv } = require('string-argv');
const StreamValues = require('stream-json/streamers/StreamValues');
const { dir, log, logOk, logWarn, logError } = require('../../extras/console')(modulename);
const helpers = require('../../extras/helpers');
const OutputHandler = require('./outputHandler');


//Helpers
const now = () => { return Math.round(Date.now() / 1000); };
const escape = (x) => {return x.replace(/"/g, '\uff02');};
const formatCommand = (cmd, ...params) => {
    return `${cmd} "` + [...params].map(escape).join('" "') + '"';
};


module.exports = class FXRunner {
    constructor(config) {
        // logOk('Started');
        this.config = config;
        this.spawnVariables = null;
        this.fxChild = null;
        this.restartDelayOverride == false;
        this.history = [];
        this.fxServerPort = null;
        this.fxServerHost = null;
        this.outputHandler = new OutputHandler(this.config.logPath, 10);

        //The setTimeout is not strictly necessary, but it's nice to have other errors in the top before fxserver starts.
        if (config.autostart && this.config.serverDataPath !== null && this.config.cfgPath !== null) {
            setTimeout(() => {
                if (globals.authenticator && globals.authenticator.admins) {
                    this.spawnServer(true);
                } else {
                    logWarn('The server will not auto start because there are no admins configured.');
                }
            }, config.autostartDelay * 1000);
        }
    }


    //================================================================
    /**
     * Refresh fxRunner configurations
     */
    refreshConfig() {
        this.config = globals.configVault.getScoped('fxRunner');
    }//Final refreshConfig()


    //================================================================
    /**
     * Setup the spawn parameters
     */
    setupVariables() {
        // Prepare extra args
        let extraArgs = [];
        if (typeof this.config.commandLine === 'string' && this.config.commandLine.length) {
            extraArgs = parseArgsStringToArgv(this.config.commandLine);
        }

        // Prepare default args
        const controllerConfigs = globals.playerController.config;
        const txAdminInterface = (GlobalData.forceInterface)
            ? `${GlobalData.forceInterface}:${GlobalData.txAdminPort}`
            : `127.0.0.1:${GlobalData.txAdminPort}`;
        const cmdArgs = [
            '+sets', 'txAdmin-version', GlobalData.txAdminVersion,
            '+setr', 'txAdmin-locale', globals.translator.language || 'en',
            '+set', 'txAdmin-apiHost', txAdminInterface,
            '+set', 'txAdmin-apiToken', globals.webServer.intercomToken,
            '+set', 'txAdmin-checkPlayerJoin', (controllerConfigs.onJoinCheckBan || controllerConfigs.onJoinCheckWhitelist).toString(),
            '+set', 'txAdminServerMode', 'true',
            ...extraArgs,
            '+set', 'onesync', this.config.onesync,
            '+exec', this.config.cfgPath,
        ];

        // Configure spawn parameters according to the environment
        if (GlobalData.osType === 'linux') {
            const alpinePath = path.resolve(GlobalData.fxServerPath, '../../');
            this.spawnVariables = {
                command: `${alpinePath}/opt/cfx-server/ld-musl-x86_64.so.1`,
                args: [
                    '--library-path', `${alpinePath}/usr/lib/v8/:${alpinePath}/lib/:${alpinePath}/usr/lib/`,
                    '--',
                    `${alpinePath}/opt/cfx-server/FXServer`,
                    '+set', 'citizen_dir', `${alpinePath}/opt/cfx-server/citizen/`,
                    ...cmdArgs,
                ],
            };
        } else if (GlobalData.osType === 'windows') {
            this.spawnVariables = {
                command: `${GlobalData.fxServerPath}/FXServer.exe`,
                args: cmdArgs,
            };
        } else {
            logError(`OS type not supported: ${GlobalData.osType}`);
            process.exit();
        }
    }//Final setupVariables()


    //================================================================
    /**
     * Spawns the FXServer and sets up all the event handlers
     * @param {boolean} announce
     * @returns {string} null or error message
     */
    spawnServer(announce) {
        //Setup variables
        this.setupVariables();
        if (GlobalData.verbose) {
            log('Spawn Variables: ' + this.spawnVariables.args.join(' '));
        }
        //Sanity Check
        if (
            this.spawnVariables == null
            || typeof this.spawnVariables.command == 'undefined'
            || typeof this.spawnVariables.args == 'undefined'
        ) {
            return logError('this.spawnVariables is not set.');
        }
        //If there is any FXServer configuration missing
        if (this.config.serverDataPath === null || this.config.cfgPath === null) {
            return logError('Cannot start the server with missing configuration (serverDataPath || cfgPath).');
        }

        //If the server is already alive
        if (this.fxChild !== null) {
            return logError('The server is already started.');
        }

        //Detecting server.cfg & endpoint port
        let rawCfgFile;
        try {
            const cfgFilePath = helpers.resolveCFGFilePath(this.config.cfgPath, this.config.serverDataPath);
            rawCfgFile = helpers.getCFGFileData(cfgFilePath);
        } catch (error) {
            const errMsg = logError(`server.cfg error: ${error.message}`);
            if (error.message.includes('unreadable')) {
                logError('You likely copied the txData folder from another server, or moved/deleted your server files.');
                logError('Please go to "Settings > FXServer" and fix the "Server Data Folder" and "CFX File Path".');
            }
            return errMsg;
        }
        try {
            this.fxServerPort = helpers.getFXServerPort(rawCfgFile);
        } catch (error) {
            const cleanedErrorMessage = error.message.replace(/<\/?code>/gi, '').replace(/<br>/gi, '');
            const outMsg = logError(`server.cfg error: \n${cleanedErrorMessage}`);
            //the IF below is only a way to disable the endpoint check
            if (globals.config.forceFXServerPort) {
                this.fxServerPort = globals.config.forceFXServerPort;
            } else {
                return outMsg;
            }
        }
        this.fxServerHost = (GlobalData.forceInterface)
            ? `${GlobalData.forceInterface}:${this.fxServerPort}`
            : `127.0.0.1:${this.fxServerPort}`;

        //Reseting hitch counter
        globals.monitor.resetMonitorStats();

        //Announcing
        if (announce === 'true' || announce === true) {
            let discordMessage = globals.translator.t('server_actions.spawning_discord', {servername: globals.config.serverName});
            globals.discordBot.sendAnnouncement(discordMessage);
        }

        //Starting server
        let pid;
        let historyIndex;
        try {
            this.fxChild = spawn(
                this.spawnVariables.command,
                this.spawnVariables.args,
                {
                    cwd: this.config.serverDataPath,
                    stdio: [ 'pipe', 'pipe', 'pipe', 'pipe' ],
                },
            );
            if (typeof this.fxChild.pid === 'undefined') {
                throw new Error(`Executon of "${this.spawnVariables.command}" failed.`);
            }
            pid = this.fxChild.pid.toString();
            logOk(`>> [${pid}] FXServer Started!`);
            this.outputHandler.writeHeader();
            this.history.push({
                pid: pid,
                timestamps: {
                    start: now(),
                    kill: false,
                    exit: false,
                    close: false,
                },
            });
            historyIndex = this.history.length - 1;
        } catch (error) {
            logError('Failed to start FXServer with the following error:');
            dir(error);
            process.exit(0);
        }

        //Setting up stream handlers
        this.fxChild.stdout.setEncoding('utf8');

        //Setting up event handlers
        this.fxChild.on('close', function (code) {
            logWarn(`>> [${pid}] FXServer Closed. (code ${code})`);
            this.history[historyIndex].timestamps.close = now();
        }.bind(this));
        this.fxChild.on('disconnect', function () {
            logWarn(`>> [${pid}] FXServer Disconnected.`);
        }.bind(this));
        this.fxChild.on('error', function (err) {
            logWarn(`>> [${pid}] FXServer Errored:`);
            dir(err);
        }.bind(this));
        this.fxChild.on('exit', function () {
            process.stdout.write('\n'); //Make sure this isn't concatenated with the last line
            logWarn(`>> [${pid}] FXServer Exited.`);
            this.history[historyIndex].timestamps.exit = now();
            if (this.history[historyIndex].timestamps.exit - this.history[historyIndex].timestamps.start <= 5) {
                setTimeout(() => {
                    logWarn('FXServer didn\'t start. This is not an issue with txAdmin.');
                }, 500);
            }
        }.bind(this));

        this.fxChild.stdin.on('error', () => {});
        this.fxChild.stdin.on('data', () => {});

        this.fxChild.stdout.on('error', () => {});
        this.fxChild.stdout.on('data', this.outputHandler.write.bind(this.outputHandler));

        this.fxChild.stderr.on('error', () => {});
        this.fxChild.stderr.on('data', this.outputHandler.writeError.bind(this.outputHandler));

        const tracePipe = this.fxChild.stdio[3].pipe(StreamValues.withParser());
        tracePipe.on('error', (data) => {
            if (GlobalData.verbose) logWarn(`FD3 decode error: ${data.message}`);
            globals.databus.txStatsData.lastFD3Error = data.message;
        });
        tracePipe.on('data', this.outputHandler.trace.bind(this.outputHandler));

        return null;
    }//Final spawnServer()


    //================================================================
    /**
     * Restarts the FXServer
     * @param {string} tReason
     */
    async restartServer(tReason) {
        try {
            //If a reason is provided, announce restart on discord, kick all players and wait 750ms
            if (typeof tReason === 'string') {
                const tOptions = {
                    servername: globals.config.serverName,
                    reason: tReason,
                };
                const kickMessage = globals.translator.t('server_actions.restarting', tOptions);
                this.srvCmd(formatCommand('quit', kickMessage));
                const discordMessage = globals.translator.t('server_actions.restarting_discord', tOptions);
                globals.discordBot.sendAnnouncement(discordMessage);
                await sleep(750);
            }

            //Restart server
            await this.killServer();
            if (this.restartDelayOverride) {
                logWarn(`Restarting the fxserver with delay override ${this.restartDelayOverride}`);
                await sleep(this.restartDelayOverride);
            } else {
                await sleep(this.config.restartDelay);
            }
            return this.spawnServer();
        } catch (error) {
            const errMsg = logError("Couldn't restart the server.");
            if (GlobalData.verbose) dir(error);
            return errMsg;
        }
    }


    //================================================================
    /**
     * Kills the FXServer
     * @param {string} tReason
     */
    async killServer(tReason) {
        try {
            //If a reason is provided, announce restart on discord, kick all players and wait 500ms
            if (typeof tReason === 'string') {
                let tOptions = {
                    servername: globals.config.serverName,
                    reason: tReason,
                };
                let discordMessage = globals.translator.t('server_actions.stopping_discord', tOptions);
                globals.discordBot.sendAnnouncement(discordMessage);
                let kickMessage = globals.translator.t('server_actions.stopping', tOptions);
                this.srvCmd(formatCommand('quit', kickMessage));
                await sleep(500);
            }

            //Stopping server
            if (this.fxChild !== null) {
                this.fxChild.kill();
                this.fxChild = null;
                this.history[this.history.length - 1].timestamps.kill = now();
            }
            return true;
        } catch (error) {
            logError("Couldn't kill the server. Perhaps What Is Dead May Never Die.");
            if (GlobalData.verbose) dir(error);
            this.fxChild = null;
            return false;
        }
    }


    //================================================================
    /**
     * Pipe a string into FXServer's stdin (aka executes a cfx's command)
     * @param {string} command
     */
    srvCmd(command) {
        if (typeof command !== 'string') throw new Error('Expected String!');
        if (this.fxChild === null) return false;
        try {
            let success = this.fxChild.stdin.write(command + '\n');
            globals.webServer.webConsole.buffer(command, 'command');
            return success;
        } catch (error) {
            if (GlobalData.verbose) {
                logError('Error writing to fxChild.stdin');
                dir(error);
            }
            return false;
        }
    }


    //================================================================
    /**
     * Pipe a string into FXServer's stdin (aka executes a cfx's command) and returns the stdout output.
     * @param {*} command
     * @param {*} bufferTime the size of the buffer in milliseconds
     * @returns {string} buffer
     */
    async srvCmdBuffer(command, bufferTime) {
        if (typeof command !== 'string') throw new Error('Expected String!');
        if (this.fxChild === null) return false;
        bufferTime = (bufferTime !== undefined) ? bufferTime : 1500;
        this.outputHandler.cmdBuffer = '';
        this.outputHandler.enableCmdBuffer = true;
        let result = this.srvCmd(command);
        if (!result) return false;
        await sleep(bufferTime);
        this.outputHandler.enableCmdBuffer = false;
        return this.outputHandler.cmdBuffer.replace(/\x1b\[\d+(;\d)?m/g, '');
    }


    //================================================================
    /**
     * Returns the status of the server, with the states being:
     *  - not started
     *  - spawn ready
     *  - spawn awaiting last: <list of pending status of last instance>
     *  - kill pending: <list of pending events from current instance>
     *  - killed
     *  - closing
     *  - closed
     *  - spawned
     * @returns {string} status
     */
    getStatus() {
        if (!this.history.length) return 'not started';
        let curr = this.history[this.history.length - 1];

        if (!curr.timestamps.start && this.history.length == 1) {
            throw new Error('This should NOT happen. Let\'s see how long people will take to find this...');
        } else if (!curr.timestamps.start) {
            let last = this.history[this.history.length - 2];
            let pending = Object.keys(last.timestamps).filter((k) => !curr.timestamps[k]);
            if (!pending.length) {
                return 'spawn ready';
            } else {
                return 'spawn awaiting last: ' + pending.join(', ');
            }
        } else if (curr.timestamps.kill) {
            let pending = Object.keys(curr.timestamps).filter((k) => !curr.timestamps[k]);
            if (pending.length) {
                return 'kill pending: ' + pending.join(', ');
            } else {
                return 'killed';
            }
        } else if (curr.timestamps.exit && !curr.timestamps.close) {
            return 'closing';
        } else if (curr.timestamps.exit && curr.timestamps.close) {
            return 'closed';
        } else {
            return 'spawned';
        }
    }


    //================================================================
    /**
     * Returns the current fxserver uptime in seconds
     * @returns {numeric} buffer
     */
    getUptime() {
        if (!this.history.length) return 0;
        let curr = this.history[this.history.length - 1];

        return now() - curr.timestamps.start;
    }
}; //Fim FXRunner()
