/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * A framed (u32 length prefix) bidirectional message channel to one peer.
 */
export class IrohConn {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    close(): void;
    /**
     * Resolves once the connection is closed (by either side or due to an error).
     */
    closed(): Promise<any>;
    /**
     * Resolves with the next message (Uint8Array), or null when the peer closed the stream.
     * Empty frames (used as stream-open marker) are skipped.
     */
    recv(): Promise<any>;
    remoteId(): string;
    send(data: Uint8Array | number[]): Promise<any>;
}

export class IrohNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Waits for the next incoming connection. Resolves to `IrohConn` or null if the endpoint closed.
     */
    accept(): Promise<any>;
    close(): Promise<any>;
    /**
     * Dials a peer by endpoint id and relay url.
     */
    connect(endpoint_id: string, relay_url: string): Promise<any>;
    /**
     * The endpoint id (public key) as a string.
     */
    endpointId(): string;
    /**
     * Resolves with the home relay URL once connected to a relay.
     */
    homeRelay(): Promise<any>;
    /**
     * The endpoint secret key, so a device can keep a stable id across reloads.
     */
    secretKey(): Uint8Array;
}

/**
 * Binds a new endpoint using the given relays (comma-separated URLs). Address lookup is
 * disabled: peers are dialed with the relay URL from the invite link.
 *
 * Browsers need relay URLs *without* a trailing dot. iroh's built-in n0 defaults are
 * fully-qualified names ("euc1-1.relay.n0.iroh.link."), which browsers can't use for
 * TLS/WebSocket — the endpoint then never comes online — so the app passes its own list.
 */
export function spawnNode(relay_url?: string | null, secret_key?: Uint8Array | number[] | null): Promise<IrohNode>;

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly __wbg_irohconn_free: (a: number, b: number) => void;
    readonly __wbg_irohnode_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly irohconn_close: (a: number) => void;
    readonly irohconn_closed: (a: number) => any;
    readonly irohconn_recv: (a: number) => any;
    readonly irohconn_remoteId: (a: number) => [number, number];
    readonly irohconn_send: (a: number, b: number, c: number) => any;
    readonly irohnode_accept: (a: number) => any;
    readonly irohnode_close: (a: number) => any;
    readonly irohnode_connect: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly irohnode_endpointId: (a: number) => [number, number];
    readonly irohnode_homeRelay: (a: number) => any;
    readonly irohnode_secretKey: (a: number) => [number, number];
    readonly spawnNode: (a: number, b: number, c: number, d: number) => any;
    readonly start: () => void;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke___js_sys_8373d5bfd33c6d5d___Function_fn_wasm_bindgen_b91c975d3771a246___JsValue_____wasm_bindgen_b91c975d3771a246___sys__Undefined___js_sys_8373d5bfd33c6d5d___Function_fn_wasm_bindgen_b91c975d3771a246___JsValue_____wasm_bindgen_b91c975d3771a246___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke___wasm_bindgen_b91c975d3771a246___JsValue__core_7d5f0a2ba6a62c33___result__Result_____wasm_bindgen_b91c975d3771a246___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke___wasm_bindgen_b91c975d3771a246___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke___web_sys_77952476eb354f31___features__gen_CloseEvent__CloseEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke___web_sys_77952476eb354f31___features__gen_MessageEvent__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke_______true__1_: (a: number, b: number) => void;
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke_______true__2_: (a: number, b: number) => void;
    readonly wasm_bindgen_b91c975d3771a246___convert__closures_____invoke_______true__3_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
