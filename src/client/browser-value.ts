/** Preserve browser interfaces while binding methods that require their native receiver. */
export function browserValue(receiver: object, property: PropertyKey): unknown {
    const value: unknown = Reflect.get(receiver, property, receiver)
    // Binding a WebIDL constructor destroys its own prototype/static members.
    // Official DOMPurify reads Element.prototype and NodeFilter.SHOW_ELEMENT;
    // all plugins must receive the actual browser interface, not a bound copy.
    if (typeof value !== 'function' || Object.hasOwn(value, 'prototype')) return value
    return value.bind(receiver)
}
