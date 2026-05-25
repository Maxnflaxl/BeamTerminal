/**
 * BEAM DApp Connector - Stable Wallet Integration Library
 *
 * A robust, production-ready library for connecting BEAM dApps to various
 * BEAM wallet environments (Desktop, Web Extension, Mobile, Headless).
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Connection state management
 * - Event-driven architecture
 * - Promise-based API with timeouts
 * - Heartbeat mechanism for connection monitoring
 * - Memory-safe callback handling
 * - TypeScript-ready JSDoc annotations
 *
 * @version 2.0.0
 * @license MIT
 * @author BEAM Community
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_AMOUNT = 0.00000001;
const MAX_AMOUNT = 254000000;
const BEAM_DECIMALS = 8;

/** Connection states */
const ConnectionState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    LOCKED: 'locked',
    ERROR: 'error'
};

/** Wallet environments */
const WalletEnvironment = {
    DESKTOP: 'desktop',      // Qt WebEngine (BEAM Desktop Wallet)
    WEB: 'web',              // Chrome Extension
    MOBILE: 'mobile',        // Android/iOS App
    HEADLESS: 'headless',    // WebAssembly client
    UNKNOWN: 'unknown'
};

/** Default configuration */
const DEFAULT_CONFIG = {
    apiVersion: 'current',
    minApiVersion: '',
    appName: 'BEAM DApp',
    headlessNode: 'eu-node01.masternet.beam.mw:8200',
    network: 'mainnet',            // 'mainnet' | 'dappnet'
    connectionTimeout: 30000,      // 30 seconds
    reconnectDelay: 1000,          // Initial reconnect delay
    maxReconnectDelay: 30000,      // Max reconnect delay
    maxReconnectAttempts: 10,      // Max reconnect attempts (0 = infinite)
    heartbeatInterval: 15000,      // Heartbeat every 15 seconds
    callTimeout: 60000,            // API call timeout
    autoReconnect: true,
    showLoader: true,
    debug: false
};

// ============================================================================
// EVENT EMITTER
// ============================================================================

/**
 * Simple event emitter for connection state changes
 */
class EventEmitter {
    constructor() {
        this._events = {};
    }

    /**
     * Subscribe to an event
     * @param {string} event - Event name
     * @param {Function} callback - Event handler
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (!this._events[event]) {
            this._events[event] = [];
        }
        this._events[event].push(callback);
        return () => this.off(event, callback);
    }

    /**
     * Subscribe to an event once
     * @param {string} event - Event name
     * @param {Function} callback - Event handler
     */
    once(event, callback) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback(...args);
        };
        this.on(event, wrapper);
    }

    /**
     * Unsubscribe from an event
     * @param {string} event - Event name
     * @param {Function} callback - Event handler to remove
     */
    off(event, callback) {
        if (!this._events[event]) return;
        this._events[event] = this._events[event].filter(cb => cb !== callback);
    }

    /**
     * Emit an event
     * @param {string} event - Event name
     * @param {...any} args - Event arguments
     */
    emit(event, ...args) {
        if (!this._events[event]) return;
        this._events[event].forEach(cb => {
            try {
                cb(...args);
            } catch (err) {
                console.error(`Event handler error for '${event}':`, err);
            }
        });
    }
}

// ============================================================================
// MAIN CONNECTOR CLASS
// ============================================================================

/**
 * BEAM DApp Connector
 *
 * @example
 * const connector = new BeamDappConnector({
 *     appName: 'My DApp',
 *     apiVersion: 'current'
 * });
 *
 * connector.on('connected', () => console.log('Connected!'));
 * connector.on('disconnected', () => console.log('Disconnected!'));
 *
 * await connector.connect();
 * const result = await connector.invokeContract('action=view_params');
 */
class BeamDappConnector extends EventEmitter {

    /**
     * Create a new BEAM DApp Connector
     * @param {Object} config - Configuration options
     * @param {string} [config.appName='BEAM DApp'] - Application name
     * @param {string} [config.apiVersion='current'] - API version
     * @param {string} [config.minApiVersion=''] - Minimum API version
     * @param {boolean} [config.autoReconnect=true] - Auto reconnect on disconnect
     * @param {boolean} [config.showLoader=true] - Show loading overlay
     * @param {boolean} [config.debug=false] - Enable debug logging
     */
    constructor(config = {}) {
        super();

        this.config = { ...DEFAULT_CONFIG, ...config };
        this.state = ConnectionState.DISCONNECTED;
        this.environment = WalletEnvironment.UNKNOWN;
        this.wallet = null;
        this.api = null;
        this.styles = null;

        // Call tracking
        this._callId = 0;
        this._pendingCalls = new Map();
        this._callTimeouts = new Map();

        // Reconnection state
        this._reconnectAttempts = 0;
        this._reconnectTimer = null;

        // Heartbeat
        this._heartbeatTimer = null;
        this._lastHeartbeat = null;

        // Message listener reference for cleanup
        this._messageListener = null;

        this._log('BeamDappConnector initialized', this.config);
    }

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    /**
     * Get current connection state
     * @returns {string} Connection state
     */
    getState() {
        return this.state;
    }

    /**
     * Check if connected
     * @returns {boolean}
     */
    isConnected() {
        return this.state === ConnectionState.CONNECTED;
    }

    /**
     * Get detected wallet environment
     * @returns {string} Wallet environment
     */
    getEnvironment() {
        return this.environment;
    }

    /**
     * Connect to BEAM wallet
     * @param {Object} [options] - Connection options
     * @param {boolean} [options.headless=false] - Use headless mode (WebAssembly)
     * @returns {Promise<boolean>} Connection success
     */
    async connect(options = {}) {
        if (this.state === ConnectionState.CONNECTED) {
            this._log('Already connected');
            return true;
        }

        if (this.state === ConnectionState.CONNECTING) {
            this._log('Connection already in progress');
            return this._waitForConnection();
        }

        this._setState(ConnectionState.CONNECTING);
        this._detectEnvironment();

        const headless = options.headless || false;

        try {
            await this._connectToWallet(headless);
            this._setState(ConnectionState.CONNECTED);
            this._startHeartbeat();
            this._reconnectAttempts = 0;
            this._applyBodyClasses();

            if (this.config.showLoader) {
                this._hideLoader();
            }

            return true;
        } catch (error) {
            this._log('Connection failed:', error);
            this._setState(ConnectionState.ERROR);

            if (this.config.autoReconnect) {
                this._scheduleReconnect();
            }

            throw error;
        }
    }

    /**
     * Disconnect from wallet
     */
    async disconnect() {
        this._stopHeartbeat();
        this._clearReconnectTimer();
        this._cancelAllPendingCalls('Disconnected');
        this._removeMessageListener();

        if (this.environment === WalletEnvironment.HEADLESS && this.wallet?.client) {
            try {
                await this._stopHeadlessWallet();
            } catch (e) {
                this._log('Error stopping headless wallet:', e);
            }
        }

        this.wallet = null;
        this.api = null;
        this._setState(ConnectionState.DISCONNECTED);
    }

    /**
     * Call wallet API method
     * @param {string} method - API method name
     * @param {Object} [params={}] - Method parameters
     * @param {number} [timeout] - Call timeout in ms
     * @returns {Promise<any>} API response
     */
    async callApi(method, params = {}, timeout = this.config.callTimeout) {
        if (!this.isConnected()) {
            throw new Error('Not connected to wallet');
        }

        const callId = `call-${++this._callId}`;

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this._pendingCalls.delete(callId);
                this._callTimeouts.delete(callId);
                reject(new Error(`API call '${method}' timed out after ${timeout}ms`));
            }, timeout);

            this._callTimeouts.set(callId, timeoutId);
            this._pendingCalls.set(callId, { resolve, reject, method });

            const request = {
                jsonrpc: '2.0',
                id: callId,
                method: method,
                params: params
            };

            this._log('API call:', method, params);
            this._sendRequest(request);
        });
    }

    /**
     * Invoke smart contract
     * @param {string} args - Contract arguments (e.g., "action=view_params,cid=...")
     * @param {Uint8Array} [contractBytes] - Optional contract bytecode
     * @param {boolean} [createTx=false] - Create transaction
     * @returns {Promise<any>} Contract response
     */
    async invokeContract(args, contractBytes = null, createTx = false) {
        const params = {
            create_tx: createTx
        };

        if (args) {
            params.args = args;
        }

        if (contractBytes) {
            params.contract = Array.from(contractBytes);
        }

        const result = await this.callApi('invoke_contract', params);

        // Parse shader output if present
        if (result?.output && typeof result.output === 'string') {
            try {
                const parsed = JSON.parse(result.output);
                if (parsed.error) {
                    throw new Error(parsed.error);
                }
                return parsed;
            } catch (e) {
                if (e.message && !e.message.includes('JSON')) {
                    throw e;
                }
                return result;
            }
        }

        return result;
    }

    /**
     * Process invoke data (confirm transaction)
     * @param {string} data - Invoke data from contract call
     * @returns {Promise<any>} Transaction result
     */
    async processInvokeData(data) {
        return this.callApi('process_invoke_data', { data });
    }

    /**
     * Get wallet status
     * @returns {Promise<Object>} Wallet status
     */
    async getWalletStatus() {
        return this.callApi('wallet_status');
    }

    /**
     * Get address list
     * @param {boolean} [own=true] - Get own addresses
     * @returns {Promise<Array>} Address list
     */
    async getAddressList(own = true) {
        return this.callApi('addr_list', { own });
    }

    /**
     * Get UTXO list
     * @param {number} [assetId=0] - Asset ID (0 = BEAM)
     * @returns {Promise<Array>} UTXO list
     */
    async getUtxoList(assetId = 0) {
        return this.callApi('get_utxo', { asset_id: assetId });
    }

    /**
     * Get transaction list
     * @param {Object} [filter] - Transaction filter
     * @returns {Promise<Array>} Transaction list
     */
    async getTxList(filter = {}) {
        return this.callApi('tx_list', { filter });
    }

    /**
     * Get assets list
     * @returns {Promise<Array>} Assets list
     */
    async getAssetsList() {
        return this.callApi('assets_list');
    }

    /**
     * Download shader bytecode from URL
     * @param {string} url - Shader URL
     * @returns {Promise<Uint8Array>} Shader bytecode
     */
    async downloadShader(url) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';

            xhr.onload = () => {
                if (xhr.status === 200) {
                    const byteArray = new Uint8Array(xhr.response);
                    if (!byteArray.length) {
                        reject(new Error('Empty shader file'));
                        return;
                    }
                    resolve(byteArray);
                } else {
                    reject(new Error(`Failed to download shader: HTTP ${xhr.status}`));
                }
            };

            xhr.onerror = () => reject(new Error('Network error downloading shader'));
            xhr.ontimeout = () => reject(new Error('Timeout downloading shader'));
            xhr.timeout = 30000;

            xhr.send();
        });
    }

    // ========================================================================
    // ENVIRONMENT DETECTION
    // ========================================================================

    /**
     * Detect wallet environment from user agent
     * @private
     */
    _detectEnvironment() {
        const ua = navigator.userAgent;

        if (/QtWebEngine/i.test(ua)) {
            this.environment = WalletEnvironment.DESKTOP;
        } else if (/android/i.test(ua) || /iPad|iPhone|iPod/.test(ua)) {
            this.environment = WalletEnvironment.MOBILE;
        } else {
            this.environment = WalletEnvironment.WEB;
        }

        this._log('Detected environment:', this.environment);
    }

    /**
     * Check if running in Chrome browser
     * @returns {boolean}
     */
    static isChrome() {
        const ua = navigator.userAgent;
        const isChrome = ua.match(/chrome|chromium|crios/i);
        return isChrome && ua.indexOf('Edg') === -1;
    }

    /**
     * Check if running on mobile
     * @returns {boolean}
     */
    static isMobile() {
        const ua = navigator.userAgent;
        return /android/i.test(ua) || /iPad|iPhone|iPod/.test(ua);
    }

    /**
     * Check if running in Desktop wallet
     * @returns {boolean}
     */
    static isDesktop() {
        return /QtWebEngine/i.test(navigator.userAgent);
    }

    /**
     * Check if running in web browser (not desktop or mobile)
     * @returns {boolean}
     */
    static isWeb() {
        return !BeamDappConnector.isDesktop() && !BeamDappConnector.isMobile();
    }

    /** IPFS gateway base URL */
    static get ipfsGateway() {
        return 'https://gallery20.apps.beam.mw/ipfs/';
    }

    /** Web cache gateway base URL */
    static get webGateway() {
        return 'https://gallery20.apps.beam.mw/cache/';
    }

    // ========================================================================
    // CONNECTION METHODS
    // ========================================================================

    /**
     * Connect to wallet based on environment
     * @private
     */
    async _connectToWallet(headless) {
        if (this.config.showLoader) {
            this._showLoader(headless);
        }

        switch (this.environment) {
            case WalletEnvironment.DESKTOP:
                return this._connectDesktop();

            case WalletEnvironment.MOBILE:
                // Use the injected bridge when the page is opened inside the BEAM
                // Mobile wallet's WebView; in a regular mobile browser fall back to
                // the headless WASM client so the dApp loads without the wallet.
                if (typeof window !== 'undefined' && window.BEAM) {
                    return this._connectMobile();
                }
                return this._connectHeadless();

            case WalletEnvironment.WEB:
                // Browsers without the BEAM Web Wallet extension (anything
                // non-Chrome, or Chrome without the extension installed) get
                // the headless WASM client so the dApp still loads.
                if (headless || !BeamDappConnector.isChrome()) {
                    return this._connectHeadless();
                }
                return this._connectWebExtension();

            default:
                throw new Error('Unknown wallet environment');
        }
    }

    /**
     * Connect to Desktop wallet (Qt WebChannel)
     * @private
     */
    async _connectDesktop() {
        await this._injectScript('qrc:///qtwebchannel/qwebchannel.js');

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Desktop wallet connection timeout'));
            }, this.config.connectionTimeout);

            try {
                new QWebChannel(qt.webChannelTransport, (channel) => {
                    clearTimeout(timeout);

                    this.wallet = channel.objects.BEAM;
                    this.api = this.wallet.api;
                    this.styles = this.wallet.style;

                    // Connect to API result signal
                    this.api.callWalletApiResult.connect((json) => {
                        this._handleApiResult(json);
                    });

                    this._log('Connected to Desktop wallet');
                    resolve();
                });
            } catch (err) {
                clearTimeout(timeout);
                reject(new Error(`Desktop connection failed: ${err.message}`));
            }
        });
    }

    /**
     * Connect to Mobile wallet
     * @private
     */
    async _connectMobile() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Mobile wallet connection timeout'));
            }, this.config.connectionTimeout);

            try {
                if (!window.BEAM) {
                    // Caller should have routed to _connectHeadless when the
                    // injected bridge is missing; reject silently rather than
                    // showing a blocking "BEAM Wallet Required" overlay.
                    clearTimeout(timeout);
                    reject(new Error('BEAM Mobile wallet not available'));
                    return;
                }

                // Android uses document events, iOS uses callback
                if (/android/i.test(navigator.userAgent)) {
                    document.addEventListener('onCallWalletApiResult', (ev) => {
                        this._handleApiResult(ev.detail);
                    });
                } else {
                    window.BEAM.callWalletApiResult((json) => {
                        this._handleApiResult(json);
                    });
                }

                this.wallet = window.BEAM;
                this.api = window.BEAM;

                clearTimeout(timeout);
                this._log('Connected to Mobile wallet');
                resolve();
            } catch (err) {
                clearTimeout(timeout);
                reject(new Error(`Mobile connection failed: ${err.message}`));
            }
        });
    }

    /**
     * Connect to Web Extension
     * @private
     */
    async _connectWebExtension() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._removeMessageListener();
                reject(new Error('Web wallet connection timeout - is BEAM Web Wallet extension installed?'));
            }, this.config.connectionTimeout);

            this._messageListener = async (ev) => {
                this._log('Message received:', ev.data);

                if (ev.data === 'apiInjected') {
                    clearTimeout(timeout);

                    try {
                        this.wallet = { api: window.BeamApi };
                        this.api = window.BeamApi;

                        await window.BeamApi.callWalletApiResult((json) => {
                            this._handleApiResult(json);
                        });

                        this._log('Connected to Web Extension');
                        resolve();
                    } catch (err) {
                        reject(new Error(`Web extension setup failed: ${err.message}`));
                    }
                }

                if (ev.data === 'rejected' || ev.data === 'apiRejected') {
                    clearTimeout(timeout);
                    reject(new Error('Connection rejected by user'));
                }
            };

            window.addEventListener('message', this._messageListener);

            // Request API injection
            window.postMessage({
                type: 'create_beam_api',
                apiver: this.config.apiVersion,
                apivermin: this.config.minApiVersion,
                appname: this.config.appName,
                is_reconnect: !!window.BeamApi
            }, window.origin);
        });
    }

    /**
     * Connect to Headless wallet (WebAssembly)
     * @private
     */
    async _connectHeadless() {
        await this._injectScript('wasm-client.js');

        return new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Headless wallet connection timeout'));
            }, this.config.connectionTimeout);

            try {
                const WasmModule = await BeamModule();
                const WasmWalletClient = WasmModule.WasmWalletClient;

                const networkType = WasmModule.Network[this.config.network] ?? WasmModule.Network.mainnet;
                const client = new WasmWalletClient(this.config.headlessNode, networkType);
                client.startWallet();

                client.subscribe((response) => {
                    this._log('Headless unexpected response:', response);
                });

                client.setApproveContractInfoHandler((info) => {
                    this._log('Headless contract approval requested:', info);
                });

                const appId = WasmWalletClient.GenerateAppID(
                    this.config.appName,
                    window.location.href
                );

                client.createAppAPI(
                    this.config.apiVersion,
                    this.config.minApiVersion,
                    appId,
                    this.config.appName,
                    (err, api) => {
                        clearTimeout(timeout);

                        if (err) {
                            reject(new Error(`Headless API creation failed: ${err}`));
                            return;
                        }

                        api.setHandler((json) => {
                            this._handleApiResult(json);
                        });

                        this.wallet = {
                            headless: true,
                            module: WasmModule,
                            factory: WasmWalletClient,
                            client,
                            appId,
                            api
                        };
                        this.api = api;
                        this.environment = WalletEnvironment.HEADLESS;

                        this._log('Connected to Headless wallet');
                        resolve();
                    }
                );
            } catch (err) {
                clearTimeout(timeout);
                reject(new Error(`Headless connection failed: ${err.message}`));
            }
        });
    }

    /**
     * Stop headless wallet
     * @private
     */
    async _stopHeadlessWallet() {
        return new Promise((resolve, reject) => {
            this.wallet.client.stopWallet((data) => {
                const running = this.wallet.client.isRunning();
                this._log('Headless wallet stopped:', data, 'still running:', running);
                running ? reject(new Error('Failed to stop')) : resolve();
            });
        });
    }

    // ========================================================================
    // API RESULT HANDLING
    // ========================================================================

    /**
     * Handle API response
     * @private
     */
    _handleApiResult(json) {
        let response;

        try {
            response = typeof json === 'string' ? JSON.parse(json) : json;
        } catch (err) {
            this._log('Failed to parse API response:', json);
            this.emit('error', new Error('Invalid API response'));
            return;
        }

        this._log('API response:', response);

        const callId = response.id;
        const pending = this._pendingCalls.get(callId);

        // Clear timeout if exists
        const timeoutId = this._callTimeouts.get(callId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this._callTimeouts.delete(callId);
        }

        // Handle user-cancel separately from true wallet lock.
        if (response.error?.code === -32021) {
            if (pending) {
                pending.reject(new Error('Request canceled by user'));
                this._pendingCalls.delete(callId);
            }
            return;
        }

        // Handle wallet locked state
        if (response.errcode === -5) {
            this._setState(ConnectionState.LOCKED);
            this.emit('locked');

            if (pending) {
                pending.reject(new Error('Wallet is locked'));
                this._pendingCalls.delete(callId);
            }
            return;
        }

        // Handle unlock
        if (response.is_locked === false) {
            if (this.state === ConnectionState.LOCKED) {
                this._setState(ConnectionState.CONNECTED);
                this.emit('unlocked');
            }
        }

        // Handle errors
        if (response.error) {
            if (pending) {
                pending.reject(new Error(response.error.message || JSON.stringify(response.error)));
                this._pendingCalls.delete(callId);
            } else {
                this.emit('error', response.error);
            }
            return;
        }

        // Handle successful response.
        // Some wallet APIs (e.g. assets_list) return data at the top level of the response
        // rather than inside `result`. Fall back to the full response so callers can still
        // access those fields (e.g. response.assets).
        if (pending) {
            pending.resolve(response.result !== undefined ? response.result : response);
            this._pendingCalls.delete(callId);
        } else {
            // Push event (no matching pending call) — e.g. ev_system_state, ev_txs_changed
            this.emit('apiEvent', response);
        }

        // Update heartbeat timestamp
        this._lastHeartbeat = Date.now();
    }

    /**
     * Send request to wallet
     * @private
     */
    _sendRequest(request) {
        const jsonStr = JSON.stringify(request);

        switch (this.environment) {
            case WalletEnvironment.DESKTOP:
            case WalletEnvironment.MOBILE:
            case WalletEnvironment.HEADLESS:
                this.api.callWalletApi(jsonStr);
                break;

            case WalletEnvironment.WEB:
                this.api.callWalletApi(request.id, request.method, request.params);
                break;

            default:
                throw new Error('Cannot send request: unknown environment');
        }
    }

    // ========================================================================
    // RECONNECTION
    // ========================================================================

    /**
     * Schedule reconnection attempt
     * @private
     */
    _scheduleReconnect() {
        if (!this.config.autoReconnect) return;

        if (this.config.maxReconnectAttempts > 0 &&
            this._reconnectAttempts >= this.config.maxReconnectAttempts) {
            this._log('Max reconnect attempts reached');
            this._setState(ConnectionState.ERROR);
            this.emit('reconnectFailed');
            return;
        }

        const delay = Math.min(
            this.config.reconnectDelay * Math.pow(2, this._reconnectAttempts),
            this.config.maxReconnectDelay
        );

        this._log(`Scheduling reconnect in ${delay}ms (attempt ${this._reconnectAttempts + 1})`);
        this._setState(ConnectionState.RECONNECTING);

        this._reconnectTimer = setTimeout(async () => {
            this._reconnectAttempts++;

            try {
                await this.connect();
                this.emit('reconnected');
            } catch (err) {
                this._log('Reconnect failed:', err);
                this._scheduleReconnect();
            }
        }, delay);
    }

    /**
     * Clear reconnect timer
     * @private
     */
    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    /**
     * Wait for ongoing connection
     * @private
     */
    _waitForConnection() {
        return new Promise((resolve) => {
            const handler = (state) => {
                if (state === ConnectionState.CONNECTED) {
                    this.off('stateChange', handler);
                    resolve(true);
                } else if (state === ConnectionState.ERROR || state === ConnectionState.DISCONNECTED) {
                    this.off('stateChange', handler);
                    resolve(false);
                }
            };
            this.on('stateChange', handler);
        });
    }

    // ========================================================================
    // HEARTBEAT
    // ========================================================================

    /**
     * Start heartbeat monitoring
     * @private
     */
    _startHeartbeat() {
        this._stopHeartbeat();
        this._lastHeartbeat = Date.now();

        this._heartbeatTimer = setInterval(async () => {
            if (!this.isConnected()) return;

            const timeSinceLastHeartbeat = Date.now() - this._lastHeartbeat;

            // If no activity for 2x heartbeat interval, check connection
            if (timeSinceLastHeartbeat > this.config.heartbeatInterval * 2) {
                this._log('Connection may be stale, checking...');

                try {
                    await this.callApi('wallet_status', {}, 5000);
                } catch (err) {
                    this._log('Heartbeat failed:', err);
                    this._setState(ConnectionState.DISCONNECTED);

                    if (this.config.autoReconnect) {
                        this._scheduleReconnect();
                    }
                }
            }
        }, this.config.heartbeatInterval);
    }

    /**
     * Stop heartbeat monitoring
     * @private
     */
    _stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    // ========================================================================
    // STATE MANAGEMENT
    // ========================================================================

    /**
     * Set connection state
     * @private
     */
    _setState(newState) {
        if (this.state === newState) return;

        const oldState = this.state;
        this.state = newState;

        this._log(`State: ${oldState} -> ${newState}`);
        this.emit('stateChange', newState, oldState);
        this.emit(newState);
    }

    /**
     * Cancel all pending calls
     * @private
     */
    _cancelAllPendingCalls(reason) {
        for (const [callId, pending] of this._pendingCalls) {
            const timeoutId = this._callTimeouts.get(callId);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pending.reject(new Error(reason));
        }
        this._pendingCalls.clear();
        this._callTimeouts.clear();
    }

    /**
     * Remove message listener
     * @private
     */
    _removeMessageListener() {
        if (this._messageListener) {
            window.removeEventListener('message', this._messageListener);
            this._messageListener = null;
        }
    }

    // ========================================================================
    // UI HELPERS
    // ========================================================================

    /**
     * Show loading overlay
     * @private
     */
    _showLoader(headless) {
        this._hideLoader(); // Remove existing loader

        const loader = document.createElement('div');
        loader.id = 'beam-connector-loader';
        loader.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(4, 37, 72, 0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 99999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            text-align: center;
            color: #fff;
            padding: 40px;
            max-width: 500px;
        `;

        content.innerHTML = `
            <div style="margin-bottom: 24px;">
                <svg width="60" height="60" viewBox="0 0 60 60" fill="none">
                    <circle cx="30" cy="30" r="28" stroke="#25c2a0" stroke-width="4"/>
                    <circle cx="30" cy="30" r="8" fill="#25c2a0">
                        <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite"/>
                    </circle>
                </svg>
            </div>
            <h2 style="margin: 0 0 12px 0; font-size: 24px; font-weight: 600;">
                Connecting to BEAM Wallet
            </h2>
            <p style="margin: 0 0 24px 0; color: #94a3b8; font-size: 14px;">
                ${headless
                    ? 'Initializing secure connection...'
                    : `Please approve the connection request in your BEAM wallet to use ${this.config.appName}`
                }
            </p>
            <div id="beam-connector-buttons" style="display: flex; gap: 12px; justify-content: center;">
                <button id="beam-retry-btn" style="
                    padding: 12px 24px;
                    border-radius: 50px;
                    border: none;
                    background: rgba(255,255,255,0.1);
                    color: #fff;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                ">Try Again</button>
                ${this.environment === WalletEnvironment.WEB ? `
                    <button id="beam-install-btn" style="
                        padding: 12px 24px;
                        border-radius: 50px;
                        border: none;
                        background: #00f6d2;
                        color: #042548;
                        font-weight: 600;
                        cursor: pointer;
                        transition: all 0.2s;
                    ">Install Web Wallet</button>
                ` : ''}
            </div>
        `;

        loader.appendChild(content);
        document.body.appendChild(loader);

        // Add event listeners
        document.getElementById('beam-retry-btn')?.addEventListener('click', () => {
            this._hideLoader();
            this.connect();
        });

        document.getElementById('beam-install-btn')?.addEventListener('click', () => {
            window.open('https://chrome.google.com/webstore/detail/beam-web-wallet/ilhaljfiglknggcoegeknjghdgampffk', '_blank');
        });
    }

    /**
     * Hide loading overlay
     * @private
     */
    _hideLoader() {
        const loader = document.getElementById('beam-connector-loader');
        if (loader) {
            loader.remove();
        }
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    /**
     * Inject external script
     * @private
     */
    async _injectScript(url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.type = 'text/javascript';
            script.async = true;
            script.src = url;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
            document.head.appendChild(script);
        });
    }

    /**
     * Debug logging
     * @private
     */
    _log(...args) {
        if (this.config.debug) {
            console.log('[BeamConnector]', ...args);
        }
    }

    // ========================================================================
    // INSTANCE CONVENIENCE METHODS
    // ========================================================================

    /**
     * Check if currently connected via headless (WebAssembly) wallet
     * @returns {boolean}
     */
    isHeadless() {
        return this.environment === WalletEnvironment.HEADLESS;
    }

    /**
     * Get wallet style theme (desktop styles or built-in defaults)
     * @returns {Object} Style palette
     */
    getStyles() {
        return this.styles || {
            appsGradientOffset: -174,
            appsGradientTop: 56,
            content_main: '#ffffff',
            background_main_top: '#035b8f',
            background_main: '#042548',
            background_popup: '#00446c',
            validator_error: '#ff625c',
        };
    }

    /**
     * Switch from headless mode to web extension
     * @returns {Promise<boolean>} True on success
     */
    async switchToWebAPI() {
        if (!this.isHeadless()) {
            throw new Error('Wallet must be in headless mode to switch');
        }
        await this.disconnect();
        return this.connect({ headless: false });
    }

    /**
     * Download a file and return bytes via callback (compatibility wrapper)
     * @param {string} url - URL to download
     * @param {Function} callback - (err, Array<number>) callback
     */
    download(url, callback) {
        this.downloadShader(url)
            .then((bytes) => callback(null, Array.from(bytes)))
            .catch((err) => callback(err.message));
    }

    /**
     * Apply body CSS classes based on the detected environment.
     * The stylesheet targets body.web / body.mobile for background colors.
     * @private
     */
    _applyBodyClasses() {
        if (this.environment === WalletEnvironment.MOBILE) {
            document.body.classList.add('mobile', 'compact');
        } else if (this.environment === WalletEnvironment.WEB || this.environment === WalletEnvironment.HEADLESS) {
            document.body.classList.add('web');
        }
    }

    // ========================================================================
    // STATIC UTILITIES
    // ========================================================================

    /**
     * Validate amount string
     * @param {string} value - Amount string
     * @returns {boolean} Is valid
     */
    static validateAmount(value) {
        const regex = /^-?\d+(\.\d*)?$/;
        const str = String(value);

        if (!str.match(regex)) return false;

        const floatValue = parseFloat(str);
        if (isNaN(floatValue)) return false;

        const afterDot = str.indexOf('.') > 0 ? str.substring(str.indexOf('.') + 1) : '0';
        if (afterDot.length > BEAM_DECIMALS) return false;

        if (floatValue < MIN_AMOUNT || floatValue > MAX_AMOUNT) return false;

        return true;
    }

    /**
     * Convert BEAM to groth
     * @param {number|string} beam - BEAM amount
     * @returns {number} Groth amount
     */
    static beamToGroth(beam) {
        return Math.round(parseFloat(beam) * Math.pow(10, BEAM_DECIMALS));
    }

    /**
     * Convert groth to BEAM
     * @param {number} groth - Groth amount
     * @returns {string} BEAM amount
     */
    static grothToBeam(groth) {
        return (groth / Math.pow(10, BEAM_DECIMALS)).toFixed(BEAM_DECIMALS);
    }

    /**
     * Format BEAM amount with commas
     * @param {number|string} amount - Amount to format
     * @param {number} [decimals=8] - Decimal places
     * @returns {string} Formatted amount
     */
    static formatAmount(amount, decimals = BEAM_DECIMALS) {
        const num = typeof amount === 'string' ? parseFloat(amount) : amount;
        return num.toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: decimals
        });
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

// Export for ES modules
export {
    BeamDappConnector,
    ConnectionState,
    WalletEnvironment,
    MIN_AMOUNT,
    MAX_AMOUNT,
    BEAM_DECIMALS
};

// Export as default
export default BeamDappConnector;

// UMD export for script tag usage
if (typeof window !== 'undefined') {
    window.BeamDappConnector = BeamDappConnector;
    window.ConnectionState = ConnectionState;
    window.WalletEnvironment = WalletEnvironment;
}