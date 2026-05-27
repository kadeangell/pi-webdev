#!/usr/bin/env node
import { run } from "./index.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    if (err && err.name === "WdpError") {
      // eslint-disable-next-line no-console
      console.error(`error: ${err.message} (code ${err.code})`);
    } else {
      console.error(err?.stack ?? String(err));
    }
    process.exit(1);
  },
);
