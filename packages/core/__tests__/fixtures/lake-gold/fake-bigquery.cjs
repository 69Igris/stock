// Stands in for `@google-cloud/bigquery` inside the lake-gold spawn test
// (MONEY-1611), via register-fake-bigquery.mjs. Records what the job SENT —
// the options a client would put on the wire — and answers from env vars.
const { appendFileSync } = require("node:fs");

class BigQuery {
  constructor(options) {
    this.options = options;
  }

  async query(options) {
    if (process.env.FAKE_BQ_LOG) {
      appendFileSync(
        process.env.FAKE_BQ_LOG,
        JSON.stringify({ client: this.options, query: options }) + "\n",
      );
    }
    if (process.env.FAKE_BQ_THROW) throw new Error(process.env.FAKE_BQ_THROW);
    return [JSON.parse(process.env.FAKE_BQ_ROWS || "[]")];
  }
}

exports.BigQuery = BigQuery;
