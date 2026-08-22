/**
 * Run async tasks with a concurrency limit.
 * Ensures we don't overwhelm the embedding server or DB connection pool.
 */
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  const executing = new Set();

  for (const [index, task] of tasks.entries()) {
    const promise = task().then((result) => {
      executing.delete(promise);
      return result;
    });
    executing.add(promise);
    results[index] = promise;

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

module.exports = { runWithConcurrency };
