/**
 * Batches Discord message writes while GTWY streams.
 * Nothing is published until the first real answer text arrives — the caller
 * decides whether that first publish creates a message or edits an existing one.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class DiscordStreamUpdater {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<object>} opts.publish
   * @param {number} [opts.chunkThreshold=8]
   * @param {number} [opts.textLimit=2000]
   * @param {number} [opts.minEditIntervalMs=1200]
   */
  constructor({ publish, chunkThreshold = 8, textLimit = 2000, minEditIntervalMs = 1200 }) {
    if (typeof publish !== "function") {
      throw new Error("DiscordStreamUpdater requires publish(text)");
    }
    this.publish = publish;
    this.chunkThreshold = Math.max(1, Number(chunkThreshold) || 8);
    this.textLimit = textLimit;
    this.minEditIntervalMs = Math.max(0, Number(minEditIntervalMs) || 1200);

    this.latestText = "";
    this.lastSent = "";
    this.chunksSinceFlush = 0;
    this.inFlight = false;
    this.dirty = false;
    this.closed = false;
    this.sentCount = 0;
    this.hasShownAnswer = false;
    this.lastFlushAt = 0;
    this._flushChain = Promise.resolve();
  }

  clip(text) {
    const t = String(text ?? "").trim();
    if (!t) return "";
    if (t.length <= this.textLimit) return t;
    return `${t.slice(0, this.textLimit - 1)}…`;
  }

  push(text) {
    if (this.closed) return;
    const clipped = this.clip(text);
    if (!clipped) return;

    this.latestText = clipped;
    this.chunksSinceFlush += 1;
    this.dirty = true;

    if (!this.hasShownAnswer) {
      this.hasShownAnswer = true;
      this.chunksSinceFlush = 0;
      this.#enqueueFlush();
      return;
    }

    if (this.chunksSinceFlush >= this.chunkThreshold) {
      this.chunksSinceFlush = 0;
      this.#enqueueFlush();
    }
  }

  #enqueueFlush() {
    this._flushChain = this._flushChain.then(() => this.#flushOnce()).catch(() => {});
  }

  async #flushOnce() {
    if (this.closed) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    if (!this.dirty) return;

    const toSend = this.latestText;
    if (!toSend || toSend === this.lastSent) {
      this.dirty = false;
      return;
    }

    const wait = this.minEditIntervalMs - (Date.now() - this.lastFlushAt);
    if (wait > 0) await sleep(wait);

    this.dirty = false;
    this.inFlight = true;
    try {
      const ok = await this.#sendWith429Retry(toSend);
      if (ok) {
        this.lastSent = toSend;
        this.sentCount += 1;
        this.lastFlushAt = Date.now();
      } else {
        this.dirty = this.latestText !== this.lastSent;
      }
    } finally {
      this.inFlight = false;
    }

    if (!this.closed && this.dirty && this.latestText && this.latestText !== this.lastSent) {
      this.#enqueueFlush();
    }
  }

  async #sendWith429Retry(text) {
    for (;;) {
      const result = await this.publish(text);
      if (result?.ok) return true;
      if (result?.status === 429 || result?.retry_after) {
        const wait = Number(result?.retry_after || 2);
        console.warn("[discord stream] 429 — retry after", wait, "s");
        await sleep(wait * 1000);
        continue;
      }
      console.error("[discord stream] publish failed:", result?.error || result);
      return false;
    }
  }

  async finish(finalText) {
    if (finalText != null) {
      const clipped = this.clip(finalText);
      if (clipped) {
        this.latestText = clipped;
        this.dirty = this.latestText !== this.lastSent;
        this.hasShownAnswer = true;
      }
    }

    while (this.dirty || this.inFlight) {
      if (!this.inFlight && this.dirty) {
        await this.#flushOnce();
      } else {
        await sleep(20);
      }
    }

    if (this.latestText && this.latestText !== this.lastSent) {
      this.inFlight = true;
      try {
        const ok = await this.#sendWith429Retry(this.latestText);
        if (ok) {
          this.lastSent = this.latestText;
          this.sentCount += 1;
        }
      } finally {
        this.inFlight = false;
      }
    }

    this.closed = true;
    return {
      sentCount: this.sentCount,
      text: this.latestText,
      lastSent: this.lastSent,
    };
  }

  stop() {
    this.closed = true;
  }
}
