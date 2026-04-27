/**
 * Патч Express Layer (аналог express-async-errors), совместимый с ESM.
 * Иначе throw из async route → необработанное отклонение и 500 без JSON.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Layer = require("express/lib/router/layer");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RouterMod = require("express/lib/router");
const last = (arr = []) => arr[arr.length - 1];
const noop = Function.prototype;
function copyFnProps(oldFn, newFn) {
    const from = oldFn;
    const to = newFn;
    Object.keys(from).forEach((key) => {
        to[key] = from[key];
    });
    return newFn;
}
function wrap(fn) {
    const newFn = function (...args) {
        const ret = fn.apply(this, args);
        const next = (args.length === 5 ? args[2] : last(args)) || noop;
        if (ret && typeof ret.catch === "function") {
            ret.catch((err) => next(err));
        }
        return ret;
    };
    Object.defineProperty(newFn, "length", { value: fn.length, writable: false });
    return copyFnProps(fn, newFn);
}
function patchRouterParam() {
    const Router = RouterMod;
    const originalParam = Router.prototype.constructor.param;
    Router.prototype.constructor.param = function param(name, fn) {
        fn = wrap(fn);
        return originalParam.call(this, name, fn);
    };
}
Object.defineProperty(Layer.prototype, "handle", {
    enumerable: true,
    get() {
        return this.__handle;
    },
    set(fn) {
        this.__handle = wrap(fn);
    }
});
patchRouterParam();
