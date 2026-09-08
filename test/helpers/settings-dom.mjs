import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../../public/settings.html", import.meta.url), "utf8");
const booleanAttributes = new Set(["hidden", "disabled", "open", "required", "checked", "autofocus"]);

// A small DOM surface for dependency-free behavior tests. Native layout, details
// and dialog behavior are also checked in the browser using the actual page.
export function settingsDom() {
  const elements = new Map();
  const downloads = [];
  const documentListeners = new Map();
  const document = {
    activeElement: null, hidden: false,
    createElement: (tag) => new Element(tag),
    getElementById: (id) => elements.get("#" + id)?.isConnected ? elements.get("#" + id) : null,
    querySelector: (selector) => document.body.querySelector(selector),
    querySelectorAll: (selector) => document.body.querySelectorAll(selector),
    addEventListener: (name, handler) => documentListeners.set(name, handler),
    dispatchEvent: (event) => documentListeners.get(event.type)?.(event),
  };

  class Element {
    constructor(tag) {
      Object.assign(this, {
        tag, tagName: tag.toUpperCase(), children: [], listeners: new Map(), attributes: {}, dataset: {},
        className: "", value: "", defaultValue: "", disabled: false, hidden: false, open: false, checked: false,
        _text: "", parentElement: null, tabIndex: 0,
      });
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        toggle: (name, enabled = !this.classList.contains(name)) => {
          const names = new Set(this.className.split(/\s+/).filter(Boolean));
          enabled ? names.add(name) : names.delete(name);
          this.className = [...names].join(" ");
          return enabled;
        },
      };
    }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this.replaceChildren(); this._text = String(value ?? ""); }
    set innerHTML(_) { throw new Error("Settings must not insert untrusted HTML"); }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get elements() { return Object.fromEntries(this.querySelectorAll("input").map((input) => [input.name, input])); }
    append(...children) {
      for (const child of children) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        this.children.push(child);
        if (this.tag === "select" && !this.value) this.value = child.value;
      }
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this._text = "";
      if (this.tag === "select") this.value = "";
      this.append(...children);
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
      this.parentElement = null;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "id") { this.id = value; elements.set("#" + value, this); }
      else if (name === "class") this.className = value;
      else if (name === "tabindex") this.tabIndex = Number(value);
      else if (booleanAttributes.has(name)) this[name] = true;
      else if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
      else if (!name.startsWith("aria-")) this[name] = value;
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    dispatch(name, values = {}) {
      const event = { target: this, currentTarget: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...values };
      return this.listeners.get(name)?.(event);
    }
    click() {
      if (this.disabled) return;
      if (this.tag === "a") downloads.push({ href: this.href, download: this.download });
      return this.dispatch("click");
    }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; this.openCount = (this.openCount || 0) + 1; }
    close() { if (this.open) { this.open = false; this.dispatch("close"); } }
    reset() { for (const input of this.querySelectorAll("input")) input.value = input.defaultValue; }
    contains(target) { return this === target || this.children.some((child) => child.contains(target)); }
    matches(selector) {
      const attrs = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
      const base = selector.replace(/\[[^\]]+\]/g, "");
      if (base.startsWith("#") && this.id !== base.slice(1)) return false;
      if (base.startsWith(".") && !this.classList.contains(base.slice(1))) return false;
      if (base && !["#", "."].includes(base[0]) && base !== this.tag) return false;
      return attrs.every(([, name, value]) => value === undefined
        ? Boolean(this[name]) || Object.hasOwn(this.attributes, name)
        : String(this[name] ?? this.attributes[name]) === value);
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  document.body = new Element("body");
  const stack = [document.body];
  const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
  for (const token of body.match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g)) {
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("</")) { stack.pop(); continue; }
    if (token.startsWith("<")) {
      const [, tag, attributes] = token.match(/^<([\w-]+)([\s\S]*?)\/?>$/);
      const node = new Element(tag);
      for (const [, name, value] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(name, value ?? "");
      stack.at(-1).append(node);
      if (!["input", "br", "hr", "img"].includes(tag)) stack.push(node);
    } else if (token.trim()) {
      const text = new Element("#text");
      text.textContent = token;
      stack.at(-1).append(text);
    }
  }

  class FormData {
    constructor(form) {
      this.entries = form.querySelectorAll("input")
        .filter((input) => input.name && !input.disabled && (input.type !== "checkbox" || input.checked))
        .map((input) => [input.name, input.value]);
    }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  return { document, elements, downloads, documentListeners, FormData };
}
