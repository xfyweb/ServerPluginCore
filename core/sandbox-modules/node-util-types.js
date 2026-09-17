// node:util/types 仿真（独立登记名：`util/types` 与 `util` 是两份 specifier，见 registry 的文件名约定）
//
// 为什么单独一个文件而不是别名到 node-util.js：**默认导出不是同一个东西**。
// Node 里 `require('util/types')` 拿到的是那个 `types` 对象本身（不是 `util` 对象），
// 生态里 `const { isDate } = require('util/types')` 与 `require('util/types').isDate` 都常见。
// 实现只有一份（在 node-util.js 里），这里只做转发——避免两份 types 表漂移。
import util from './node-util.js';

const types = util.types;

export default types;
export const isAnyArrayBuffer = types.isAnyArrayBuffer;
export const isArrayBuffer = types.isArrayBuffer;
export const isArrayBufferView = types.isArrayBufferView;
export const isArgumentsObject = types.isArgumentsObject;
export const isAsyncFunction = types.isAsyncFunction;
export const isBigInt64Array = types.isBigInt64Array;
export const isBigIntObject = types.isBigIntObject;
export const isCryptoKey = types.isCryptoKey;
export const isKeyObject = types.isKeyObject;
export const isBigUint64Array = types.isBigUint64Array;
export const isBooleanObject = types.isBooleanObject;
export const isBoxedPrimitive = types.isBoxedPrimitive;
export const isDataView = types.isDataView;
export const isDate = types.isDate;
export const isExternal = types.isExternal;
export const isFloat16Array = types.isFloat16Array;
export const isFloat32Array = types.isFloat32Array;
export const isFloat64Array = types.isFloat64Array;
export const isGeneratorFunction = types.isGeneratorFunction;
export const isGeneratorObject = types.isGeneratorObject;
export const isInt8Array = types.isInt8Array;
export const isInt16Array = types.isInt16Array;
export const isInt32Array = types.isInt32Array;
export const isMap = types.isMap;
export const isMapIterator = types.isMapIterator;
export const isModuleNamespaceObject = types.isModuleNamespaceObject;
export const isNativeError = types.isNativeError;
export const isNumberObject = types.isNumberObject;
export const isPromise = types.isPromise;
export const isProxy = types.isProxy;
export const isRegExp = types.isRegExp;
export const isSet = types.isSet;
export const isSetIterator = types.isSetIterator;
export const isSharedArrayBuffer = types.isSharedArrayBuffer;
export const isStringObject = types.isStringObject;
export const isSymbolObject = types.isSymbolObject;
export const isTypedArray = types.isTypedArray;
export const isUint8Array = types.isUint8Array;
export const isUint8ClampedArray = types.isUint8ClampedArray;
export const isUint16Array = types.isUint16Array;
export const isUint32Array = types.isUint32Array;
export const isWeakMap = types.isWeakMap;
export const isWeakSet = types.isWeakSet;
