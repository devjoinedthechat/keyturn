#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { type Io, run } from "./cli.ts";

const io: Io = {
  env: process.env,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
};
if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
  io.ask = async (question) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await terminal.question(question);
    } finally {
      terminal.close();
    }
  };
}

process.exitCode = await run(process.argv.slice(2), io);
