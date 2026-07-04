
export function InitialCaps(txt) {

    if (typeof txt === 'string') {

        let initial = txt[0];

        return initial.toLocaleUpperCase() + txt.substring(1);
    }

    return undefined

}

export function fixedNum(value, precision = 2) {

    if (typeof value === "number") {
        return value.toFixed(precision);
    }
    return "--";
}

export function debounce(func, timeout = 300) {
    let timer = undefined;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    }
}

/**
 * Format a table cell value according to a named format string.
 * Used with fields_config[col].format in dynamic table views.
 */
export function formatCell(value, fmt) {
    switch (fmt) {
        case 'fixedNum2': return fixedNum(value);
        case 'fixedNum4': return fixedNum(value, 4);
        case 'date':      return value ? new Date(value).toLocaleDateString() : '—';
        case 'money':     return value != null ? fixedNum(value, 2) : '—';
        case 'fallback':  return value || '—';
        default:          return value;
    }
}
