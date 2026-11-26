/* @ts-self-types="./games_iroh_wasm.d.ts" */

export class IntoUnderlyingByteSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingByteSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get autoAllocateChunkSize() {
        const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingbytesource_cancel(ptr);
    }
    /**
     * @param {ReadableByteStreamController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    /**
     * @param {ReadableByteStreamController} controller
     */
    start(controller) {
        wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
    }
    /**
     * @returns {ReadableStreamType}
     */
    get type() {
        const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr);
        return __wbindgen_enum_ReadableStreamType[ret];
    }
}
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;

export class IntoUnderlyingSink {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSinkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsink_free(ptr, 0);
    }
    /**
     * @param {any} reason
     * @returns {Promise<any>}
     */
    abort(reason) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_abort(ptr, reason);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_close(ptr);
        return ret;
    }
    /**
     * @param {any} chunk
     * @returns {Promise<any>}
     */
    write(chunk) {
        const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;

export class IntoUnderlyingSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsource_free(ptr, 0);
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingsource_cancel(ptr);
    }
    /**
     * @param {ReadableStreamDefaultController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;

/**
 * A framed (u32 length prefix) bidirectional message channel to one peer.
 */
export class IrohConn {
    static __wrap(ptr) {
        const obj = Object.create(IrohConn.prototype);
        obj.__wbg_ptr = ptr;
        IrohConnFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IrohConnFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_irohconn_free(ptr, 0);
    }
    close() {
        wasm.irohconn_close(this.__wbg_ptr);
    }
    /**
     * Resolves once the connection is closed (by either side or due to an error).
     * @returns {Promise<any>}
     */
    closed() {
        const ret = wasm.irohconn_closed(this.__wbg_ptr);
        return ret;
    }
    /**
     * Resolves with the next message (Uint8Array), or null when the peer closed the stream.
     * Empty frames (used as stream-open marker) are skipped.
     * @returns {Promise<any>}
     */
    recv() {
        const ret = wasm.irohconn_recv(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    remoteId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.irohconn_remoteId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {Uint8Array | number[]} data
     * @returns {Promise<any>}
     */
    send(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.irohconn_send(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) IrohConn.prototype[Symbol.dispose] = IrohConn.prototype.free;

export class IrohNode {
    static __wrap(ptr) {
        const obj = Object.create(IrohNode.prototype);
        obj.__wbg_ptr = ptr;
        IrohNodeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IrohNodeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_irohnode_free(ptr, 0);
    }
    /**
     * Waits for the next incoming connection. Resolves to `IrohConn` or null if the endpoint closed.
     * @returns {Promise<any>}
     */
    accept() {
        const ret = wasm.irohnode_accept(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ret = wasm.irohnode_close(this.__wbg_ptr);
        return ret;
    }
    /**
     * Dials a peer by endpoint id and relay url.
     * @param {string} endpoint_id
     * @param {string} relay_url
     * @returns {Promise<any>}
     */
    connect(endpoint_id, relay_url) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(endpoint_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(relay_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.irohnode_connect(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * The endpoint id (public key) as a string.
     * @returns {string}
     */
    endpointId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.irohnode_endpointId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Resolves with the home relay URL once connected to a relay.
     * @returns {Promise<any>}
     */
    homeRelay() {
        const ret = wasm.irohnode_homeRelay(this.__wbg_ptr);
        return ret;
    }
    /**
     * The endpoint secret key, so a device can keep a stable id across reloads.
     * @returns {Uint8Array}
     */
    secretKey() {
        const ret = wasm.irohnode_secretKey(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) IrohNode.prototype[Symbol.dispose] = IrohNode.prototype.free;

/**
 * Binds a new endpoint using the given relays (comma-separated URLs). Address lookup is
 * disabled: peers are dialed with the relay URL from the invite link.
 *
 * Browsers need relay URLs *without* a trailing dot. iroh's built-in n0 defaults are
 * fully-qualified names ("euc1-1.relay.n0.iroh.link."), which browsers can't use for
 * TLS/WebSocket — the endpoint then never comes online — so the app passes its own list.
 * @param {string | null} [relay_url]
 * @param {Uint8Array | number[] | null} [secret_key]
 * @returns {Promise<IrohNode>}
 */
export function spawnNode(relay_url, secret_key) {
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = isLikeNone(relay_url) ? 0 : passStringToWasm0(relay_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = isLikeNone(secret_key) ? 0 : passArray8ToWasm0(secret_key, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.spawnNode(ptr0, len0, ptr1, len1);
    return ret;
}

export function start() {
    wasm.start();

[Showing lines 1-300 of 1314. Use :301 to continue]