/**
 * Basic event emitter implementation, to avoid extra requirements.
 */
export default class Subscribable {
    private events: Record<string, Set<any>> = {};

    /**
     * Listen for events that are emitted of a specific type.
     * @param event
     * @param callback A function which, when called, will unregister the callback.
     */
    public subscribe(event: string, callback: any) {
        this.events[event] = this.events[event] || new Set();
        this.events[event].add(callback);

        return () => {
            this.events[event].delete(callback);
            if (!this.events[event].size) {
                delete this.events[event];
            }
        }
    }

    /**
     * Same as subscribe, but only triggers one time & automatically cleans up.
     * @param event
     * @param callback
     */
    public once(event: string, callback: Function) {
        const unsub = this.subscribe(event, (val: any) => {
            unsub();
            callback(val)
        });

        return unsub;
    }

    /**
     * Emit the given value for the given event, to all listeners.
     * @param event
     * @param val
     * @protected
     */
    protected emit(event: string, val?: any) {
        const listeners = this.events[event];

        if (listeners) {
            listeners.forEach(l => {
                l(val);
            })
        }
    }
}
