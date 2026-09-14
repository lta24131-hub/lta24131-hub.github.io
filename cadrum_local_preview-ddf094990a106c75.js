export class LocalStepSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LocalStepSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        __wbg_call_guard();
        try {
            wasm.__wbg_localstepsession_free(ptr, 0);
        } catch(e) {
            __wbg_handle_catch(e);
        }

    }
    /**
     * @returns {number}
     */
    converted_count() {
        let ret;
        __wbg_call_guard();
        try {
            ret = wasm.localstepsession_converted_count(this.__wbg_ptr);
        } catch(e) {
            __wbg_handle_catch(e);
        }
        return ret >>> 0;
    }
    /**
     * @returns {Float64Array}
     */
    model_bounds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            __wbg_call_guard();
            try {
                wasm.localstepsession_model_bounds(retptr, this.__wbg_ptr);
            } catch(e) {
                __wbg_handle_catch(e);
            }
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {Uint8Array} step
     */
    constructor(step) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(step, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            __wbg_call_guard();
            try {
                wasm.localstepsession_new(retptr, ptr0, len0);
            } catch(e) {
                __wbg_handle_catch(e);
            }
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeFromExternrefTable0(r1);
            }
            this.__wbg_ptr = r0;
            LocalStepSessionFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {number} linear_ratio
     * @param {number} angular
     * @returns {Uint8Array}
     */
    next_part_glb(linear_ratio, angular) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            __wbg_call_guard();
            try {
                wasm.localstepsession_next_part_glb(retptr, this.__wbg_ptr, linear_ratio, angular);
            } catch(e) {
                __wbg_handle_catch(e);
            }
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeFromExternrefTable0(r2);
            }
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    parse_millis() {
        let ret;
        __wbg_call_guard();
        try {
            ret = wasm.localstepsession_parse_millis(this.__wbg_ptr);
        } catch(e) {
            __wbg_handle_catch(e);
        }
        return ret;
    }
    /**
     * @returns {number}
     */
    part_count() {
        let ret;
        __wbg_call_guard();
        try {
            ret = wasm.localstepsession_part_count(this.__wbg_ptr);
        } catch(e) {
            __wbg_handle_catch(e);
        }
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    rank_millis() {
        let ret;
        __wbg_call_guard();
        try {
            ret = wasm.localstepsession_rank_millis(this.__wbg_ptr);
        } catch(e) {
            __wbg_handle_catch(e);
        }
        return ret;
    }
}
if (Symbol.dispose) LocalStepSession.prototype[Symbol.dispose] = LocalStepSession.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function() { return wrapError(function (arg0, arg1) {
            throw new WebAssembly.Exception(__wbindgen_wrapped_jstag, [new Error(getStringFromWasm0(arg0, arg1))]);
        }, arguments); },
        __wbg_now_83daa7072f38f492: function() { return wrapError(function () {
            const ret = performance.now();
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000001: function() { return wrapError(function (arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        }, arguments); },
        __wbindgen_init_externref_table: function() { return wrapError(function () {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        }, arguments); },
        __wbindgen_jstag: __wbindgen_jstag_polyfill,
        __wbindgen_wrapped_jstag: __wbindgen_wrapped_jstag,
    };
    return {
        __proto__: null,
        "./cadrum_local_preview_bg.js": import0,
    };
}

const __wbindgen_jstag_polyfill = new WebAssembly.Tag({ parameters: ['externref'] });


const __wbindgen_wrapped_jstag = new WebAssembly.Tag({ parameters: ['externref'] });


let __wbg_terminated_addr;
let __wbg_called_abort = false;
function __wbg_call_abort_hook() {
    __wbg_called_abort = true;
    try {
        const idx = getInt32ArrayMemory0()[wasm.__abort_handler.value / 4];
        if (idx) wasm.__wbindgen_export.get(idx)();
    } catch(_) {}
}

function __wbg_handle_catch(e) {
    if (e instanceof WebAssembly.Exception && e.is(__wbindgen_wrapped_jstag)) {
        throw e.getArg(__wbindgen_wrapped_jstag, 0);
    }
    getInt32ArrayMemory0()[__wbg_terminated_addr] = 1;
    __wbg_call_abort_hook();
    throw e;
}


function __wbg_call_guard() {
    __wbg_terminated_addr ??= wasm.__instance_terminated.value / 4;
    const flag = getInt32ArrayMemory0()[__wbg_terminated_addr];
    if (flag) {
        if (!__wbg_called_abort) {
            __wbg_call_abort_hook();
        }throw new Error('Module terminated');
    }
}
const LocalStepSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_localstepsession_free(ptr, 1));

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__wbindgen_export4(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

function wrapError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        if (e instanceof WebAssembly.Exception) throw e;
        throw new WebAssembly.Exception(__wbindgen_jstag_polyfill, [e], { traceStack: true });
    }
}

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('cadrum_local_preview_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
