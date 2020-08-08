/**
 * @hidden
 * @internal
 */

/**
 * Basic event emitter implementation, to avoid extra requirements.
 */
export default class Subscribable {
    private events: Record<string, Set<any>> = {};
    private permanentHandlers: Record<string, any[]> = {};

    /**
     * Listen for events that are emitted of a specific type.
     * @param event
     * @param callback A function which, when called, will unregister the callback.
     */
    public on(event: string, callback: any) {
        this.events[event] = this.events[event] || new Set();
        this.events[event].add(callback);

        return () => {
            if (this.events[event]) {
                this.events[event].delete(callback);
                if (!this.events[event].size) {
                    delete this.events[event];
                }
            }
        }
    }

    /**
     * Same as {@link on on()}, but only triggers one time & automatically cleans up.
     * @param event
     * @param callback
     * @see {@link on} for the available specific events.
     */
    public once(event: string, callback: Function) {
        const unsub = this.on(event, (val: any) => {
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

    /**
     * Register an event that cannot be cleared, even by {@link removeAllListeners}.
     * Used internally to guarantee certain events (close, etc.) are detected.
     * @param event
     * @param handler
     * @ignore
     */
    public permanent(event: string, handler: any) {
        this.permanentHandlers[event] = this.permanentHandlers[event] || [];
        this.permanentHandlers[event].push(handler);
        this.on(event, handler);
    }

    /**
     * Removes all non-permanent callbacks for the given event type, or every event type if none is given.
     * @param event
     */
    public removeAllListeners(event?: string): this {
        if (event) {
            delete this.events[event];
        } else {
            for (const k of Object.keys(this.events)) {
                delete this.events[k];
            }
        }

        const events = event? [event] : Object.keys(this.permanentHandlers);
        events.forEach(ev => {
            const handlers = this.permanentHandlers[ev];
            if (handlers) {
                handlers.forEach(h => this.on(ev, h))
            }
        })

        return this;
    }
}
