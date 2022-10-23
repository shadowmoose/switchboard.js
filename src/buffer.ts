
/**
 * Extremely basic buffer implementation to make my buffer-using code more readable.
 * @internal
 * @hidden
 */
export default class BufferWrapper {
    private buffs: Uint8Array[] = [];
    private readHead = 0;
    private len = 0;
    private concatenated: Uint8Array | null = null;

    /**
     * Quick and dirty wrapper for stream-like buffer reading and writing.
     * @param buffer
     */
    constructor(buffer?: Uint8Array[]) {
        if (buffer) {
            buffer.forEach(b => this.write(b));
        }
    }

    get length() {
        return this.len;
    }

    write(buffer: Uint8Array) {
        if (this.concatenated) throw Error("Cannot write after reading!");
        this.buffs.push(buffer);
        this.len += buffer.length;
    }

    writeInt(val: number) {
        this.write(new Uint8Array([val]));
    }

    read(len: number) {
        if (!this.concatenated) {
            this.concatenated = this.generate();
            this.buffs = [];
            this.readHead = 0;
            this.len = this.concatenated.length;
        }
        const res = this.concatenated.slice(this.readHead, this.readHead + len);
        this.readHead += res.length;

        return res;
    }

    readInt() {
        return this.read(1)[0];
    }

    readRemaining() {
        return this.read(this.length)
    }

    /**
     * Make the full buffer by combining all the input data in the order it was added.
     */
    generate() {
        const nb = new Uint8Array(this.length)
        let idx = 0;
        this.buffs.forEach(b => {
            nb.set(b, idx);
            idx += b.length;
        })

        return nb;
    }

    static areEqual(first: Uint8Array, second: Uint8Array) {
        return first.length === second.length && first.every((value, index) => value === second[index]);
    }
}
