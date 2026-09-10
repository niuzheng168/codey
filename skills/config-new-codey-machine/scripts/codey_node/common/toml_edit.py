"""Small lossless TOML editor, with tomllib as the semantic safety boundary."""
from copy import deepcopy
from datetime import date, datetime, time
import json
import math
import tomllib

from .errors import SetupError


def same(left, right):
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same(a, b) for a, b in zip(left, right))
    return (isinstance(left, float) and math.isnan(left) and math.isnan(right)) or left == right


def literal(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value).lower()
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(literal(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(literal(key) + " = " + literal(item) for key, item in value.items()) + " }"
    raise SetupError("Unsupported TOML value; configuration was not changed")


def _key(text):
    value = tomllib.loads(text + " = 0")
    result = []
    while isinstance(value, dict) and len(value) == 1:
        name, value = next(iter(value.items()))
        result.append(name)
    if value != 0:
        raise SetupError("Ambiguous TOML key; configuration was not changed")
    return tuple(result)


def _string_end(text, start):
    quote = text[start]
    triple = text.startswith(quote * 3, start)
    index = start + (3 if triple else 1)
    while index < len(text):
        if quote == '"' and text[index] == "\\":
            index += 2
        elif text[index] == quote:
            end = index + 1
            if not triple:
                return end
            while end < len(text) and text[end] == quote:
                end += 1
            if end - index >= 3:
                return end
            index = end
        else:
            index += 1
    raise SetupError("Unterminated TOML string; configuration was not changed")


def _value_end(text, start):
    index, depth = start, 0
    while index < len(text):
        char = text[index]
        if char in "\"'":
            index = _string_end(text, index)
            continue
        if char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
        elif char == "#":
            if depth == 0:
                break
            index = text.find("\n", index)
            if index < 0:
                index = len(text)
            continue
        elif char in "\r\n" and depth == 0:
            break
        index += 1
    return index - (len(text[start:index]) - len(text[start:index].rstrip()))


def _statements(text):
    """Only find spans; tomllib, not this scanner, decides validity."""
    index, section = 0, ()
    assignments, sections = [], [((), 0, False)]
    while index < len(text):
        if text[index].isspace():
            index += 1
            continue
        if text[index] == "#":
            end = text.find("\n", index)
            index = len(text) if end < 0 else end + 1
            continue
        end = _value_end(text, index)
        if text[index] == "[":
            array = text.startswith("[[", index)
            width = 2 if array else 1
            section = _key(text[index + width:end - width])
            sections.append((section, index, array))
        else:
            equal = index
            while text[equal] != "=":
                equal = _string_end(text, equal) if text[equal] in "\"'" else equal + 1
            key = section + _key(text[index:equal].strip())
            start = equal + 1
            while start < end and text[start] in " \t":
                start += 1
            assignments.append((key, start, end))
        index = end
    return assignments, sections


def _lookup(value, path):
    for key in path:
        value = value[key]
    return value


def merge(text, updates):
    """Set explicit leaf paths, preserving other values and untouched source bytes."""
    try:
        original = tomllib.loads(text)
        expected = deepcopy(original)
        for path, value in updates.items():
            table = expected
            for key in path[:-1]:
                table = table.setdefault(key, {})
                if not isinstance(table, dict):
                    raise SetupError("A managed TOML table has an incompatible type; review it first")
            if path[-1] in table and isinstance(table[path[-1]], (dict, list)):
                raise SetupError("A managed TOML setting has an incompatible type; review it first")
            table[path[-1]] = value
        if same(original, expected):
            return text
        assignments, sections = _statements(text)
        edits, handled = {}, set()
        for path, start, end in assignments:
            affected = {key for key in updates if key[:len(path)] == path}
            if not affected:
                continue
            before, after = _lookup(original, path), _lookup(expected, path)
            if not same(before, after):
                edits[(start, end)] = literal(after)
            handled.update(affected)
        newline = "\r\n" if "\r\n" in text else "\n"
        insertions = {}
        for path, value in updates.items():
            if path in handled:
                continue
            candidates = [(len(table), position, table) for position, (table, _, array) in enumerate(sections)
                          if not array and path[:len(table)] == table and len(table) < len(path)]
            _, position, table = max(candidates)
            end = sections[position + 1][1] if position + 1 < len(sections) else len(text)
            key = ".".join(literal(part) for part in path[len(table):])
            insertions.setdefault(end, []).append(key + " = " + literal(value) + newline)
        for end, lines in insertions.items():
            prefix = newline if end and text[end - 1] != "\n" else ""
            edits[(end, end)] = prefix + "".join(lines)
        result = text
        for (start, end), replacement in sorted(edits.items(), reverse=True):
            result = result[:start] + replacement + result[end:]
        if not same(tomllib.loads(result), expected):
            raise SetupError("TOML preservation check failed; configuration was not changed")
        return result
    except (tomllib.TOMLDecodeError, KeyError, TypeError, IndexError, ValueError):
        # Do not echo parser context: a line can contain credentials.
        raise SetupError("Cannot safely edit this TOML document; configuration was not changed") from None
