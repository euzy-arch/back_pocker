/**
 * Патч Express Layer (аналог express-async-errors), совместимый с ESM.
 * Иначе throw из async route → необработанное отклонение и 500 без JSON.
 */
import { createRequire } from "node:module";
import type { NextFunction, Request, Response } from "express";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Layer = require("express/lib/router/layer") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RouterMod = require("express/lib/router") as any;

const last = (arr: unknown[] = []) => arr[arr.length - 1];
const noop = Function.prototype;

function copyFnProps(oldFn: (...args: unknown[]) => unknown, newFn: (...args: unknown[]) => unknown) {
  const from = oldFn as unknown as Record<string, unknown>;
  const to = newFn as unknown as Record<string, unknown>;
  Object.keys(from).forEach((key) => {
    to[key] = from[key];
  });
  return newFn;
}

function wrap(fn: (...args: unknown[]) => unknown) {
  const newFn = function (this: unknown, ...args: unknown[]) {
    const ret = fn.apply(this, args);
    const next = (args.length === 5 ? args[2] : last(args)) || noop;
    if (ret && typeof (ret as Promise<unknown>).catch === "function") {
      (ret as Promise<unknown>).catch((err: unknown) => (next as (e: unknown) => void)(err));
    }
    return ret;
  };
  Object.defineProperty(newFn, "length", { value: fn.length, writable: false });
  return copyFnProps(fn, newFn);
}

function patchRouterParam() {
  const Router = RouterMod;
  const originalParam = Router.prototype.constructor.param;
  Router.prototype.constructor.param = function param(name: string, fn: (...args: unknown[]) => unknown) {
    fn = wrap(fn);
    return originalParam.call(this, name, fn);
  };
}

Object.defineProperty(Layer.prototype, "handle", {
  enumerable: true,
  get(this: { __handle?: unknown }) {
    return this.__handle;
  },
  set(this: { __handle?: unknown }, fn: (req: Request, res: Response, next: NextFunction) => unknown) {
    this.__handle = wrap(fn as unknown as (...args: unknown[]) => unknown);
  }
});

patchRouterParam();
