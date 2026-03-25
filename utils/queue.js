class ProcessingQueue {
  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._tryNext();
    });
  }

  _tryNext() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
    this.running++;
    const { fn, resolve, reject } = this.queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        this.running--;
        this._tryNext();
      });
  }

  get status() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent
    };
  }
}

const queue = new ProcessingQueue(parseInt(process.env.MAX_CONCURRENT || '3'));

module.exports = queue;
