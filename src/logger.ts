/**
 * @hidden The debug-logging method. Defaults to noop.
 */
let debug = (..._args: any)=>{};

/**
 * Returns a logging function, which obeys the setLogging configuration.
 * @internal
 */
export function getLogger(prefix: string) {
    const pref = `[${prefix}]`
    return (...args: any) => debug(new Date().toLocaleTimeString(), pref, ...args);
}


/**
 * Enable/disable debug logging. Optionally provide your own custom logging callback.
 * @param enabled If logging should be enabled.
 * @param callback Pass a custom function if you wish to override the default `console.debug` behavior.
 * @internal
 */
export function setLogging(enabled: boolean, callback: any = console.debug) {
    if (enabled) {
        debug = callback;
    } else {
        debug = () => {};
    }
}
