import assert from "node:assert/strict";
import test from "node:test";
import { mountBoardPicker } from "../src/board-picker.js";
import { messageBoardConfig } from "../src/config.js";

function mount(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  function element(tag = "div") {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    let text = "";
    return {
      tagName: tag.toUpperCase(), children: [], value: "", disabled: false, hidden: false,
      get textContent() { return text + this.children.map(child => child.textContent).join(""); },
      set textContent(value) { text = value; this.children = []; },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { text = ""; this.children = nodes; },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: name => attributes.get(name) ?? null,
      removeAttribute: name => attributes.delete(name),
      setCustomValidity(value) { this.validationMessage = value; },
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
      contains(node) { return node === this || this.children.some(child => child.contains(node)); },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      dispatch(name, options = {}) {
        const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
        for (const listener of listeners.get(name) ?? []) listener(event);
        return event;
      },
      focus() {
        if (document.activeElement === this) return;
        document.activeElement = this;
        this.dispatch("focus");
      },
      select() {},
      scrollIntoView() { this.scrolledIntoView = true; },
    };
  }
  const elements = Object.fromEntries(["picker", "selected-icon", "results", "options", "results-status"]
    .map(name => [`#create-board-${name}`, element()]));
  const input = elements["#create-board"] = element("input");
  const root = elements["#create-board-picker"];
  const panel = elements["#create-board-results"];
  const list = elements["#create-board-options"];
  const status = elements["#create-board-results-status"];
  const icon = elements["#create-board-selected-icon"];
  panel.hidden = true;
  root.append(input, icon, panel);
  panel.append(list, status);
  const doc = { ...element(), createElement: element, querySelector: selector => elements[selector] };
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  let changes = 0;
  const picker = mountBoardPicker(() => { changes++; });
  return { picker, input, root, panel, list, status, icon, doc, changes: () => changes,
    search(value) { input.value = value; input.dispatch("input"); },
    key(key, options) { return input.dispatch("keydown", { key, ...options }); },
  };
}

const boards = Array.from({ length: 2100 }, (_, index) => ({
  id: `board-${index}`, slug: `sub-${String(index).padStart(4, "0")}`, name: `Community ${index}`, description: "",
}));
const logoBoard = {
  id: "orchard", slug: "orchard-club", name: "Garden and Orchard Club", description: "Garden discussions",
  logo_url: "/board-logos/123e4567-e89b-12d3-a456-426614174000.webp",
};

test("type-ahead searches thousands of sub-yaps by slug and name while rendering at most 20 matches", t => {
  const page = mount(t);
  page.picker.setBoards([...boards, logoBoard]);
  page.input.focus();
  assert.equal(page.list.children.length, 20);
  assert.match(page.status.textContent, /Showing 20 of .* sub-yaps/);
  page.search("y/SUB-2099");
  assert.equal(page.list.children.length, 1);
  assert.match(page.list.textContent, /y\/sub-2099/);
  page.key("Enter");
  assert.equal(page.picker.value, "board-2099");
  assert.equal(page.input.value, "y/sub-2099");
  assert.equal(page.panel.hidden, true);
  page.search("ORCHARD garden");
  assert.equal(page.list.children.length, 1);
  assert.match(page.list.textContent, /Garden and Orchard Club/);
  page.key("Enter");
  assert.equal(page.picker.value, logoBoard.id);
});

test("editing a selection blocks posting until a choice is made, and Escape restores the previous choice", t => {
  const page = mount(t);
  page.picker.setBoards(boards, "board-2099");
  page.input.focus();
  assert.match(page.list.children[0].textContent, /y\/sub-2099/);
  assert.equal(page.input.validationMessage, "");
  page.search("missing-community");
  assert.equal(page.picker.value, "");
  assert.notEqual(page.input.validationMessage, "");
  assert.equal(page.icon.hidden, true);
  assert.equal(page.status.textContent, "No sub-yaps found.");
  assert.equal(page.input.getAttribute("aria-activedescendant"), null);
  assert.equal(page.key("Enter").defaultPrevented, true);
  assert.equal(page.picker.value, "");
  assert.equal(page.key("Escape").defaultPrevented, true);
  assert.equal(page.picker.value, "board-2099");
  assert.equal(page.input.validationMessage, "");
  assert.equal(page.panel.hidden, true);
  assert.equal(page.input.getAttribute("aria-expanded"), "false");
  assert.ok(page.changes() >= 2);
});

test("arrow keys navigate visible choices and Enter selects without submitting the message", t => {
  const page = mount(t);
  page.picker.setBoards(boards);
  page.input.focus();
  page.key("ArrowDown");
  assert.equal(page.list.children[1].getAttribute("aria-selected"), "true");
  assert.equal(page.input.getAttribute("aria-activedescendant"), page.list.children[1].id);
  assert.equal(page.list.children[1].scrolledIntoView, true);
  assert.equal(page.picker.value, "");
  assert.equal(page.key("Enter").defaultPrevented, true);
  assert.equal(page.picker.value, "board-1");
  page.key("ArrowUp");
  assert.equal(page.list.children[19].getAttribute("aria-selected"), "true");
  page.key("Tab");
  assert.equal(page.panel.hidden, true);
  page.picker.setDisabled(true);
  page.input.dispatch("click");
  assert.equal(page.panel.hidden, true);
});

test("logos display in results and selections, with initials for missing or broken images", t => {
  const page = mount(t);
  page.picker.setBoards([logoBoard, boards[0]]);
  page.input.focus();
  const avatar = page.list.children[0].children[0];
  const image = avatar.children[0];
  assert.equal(image.src, `${messageBoardConfig.apiOrigin}${logoBoard.logo_url}`);
  assert.equal(image.alt, "");
  image.onerror();
  assert.equal(avatar.textContent, "O");
  assert.equal(avatar.children.length, 0);
  assert.equal(page.list.children[1].children[0].textContent, "S");
  page.list.children[0].dispatch("click");
  assert.equal(page.picker.value, logoBoard.id);
  assert.equal(page.icon.hidden, false);
  assert.equal(page.icon.children[0].children[0].src, image.src);
  page.picker.reset();
  assert.equal(page.picker.value, "");
  assert.equal(page.input.value, "");
  assert.equal(page.icon.hidden, true);
  page.picker.setBoards([boards[0]]);
  assert.equal(page.picker.value, "");
});

test("leaving the picker closes results and composing text does not select an option", t => {
  const page = mount(t);
  page.picker.setBoards(boards);
  page.input.focus();
  assert.equal(page.key("Enter", { isComposing: true }).defaultPrevented, undefined);
  assert.equal(page.picker.value, "");
  page.root.dispatch("focusout", { relatedTarget: {} });
  assert.equal(page.panel.hidden, true);
  page.input.dispatch("click");
  page.doc.dispatch("pointerdown", { target: {} });
  assert.equal(page.panel.hidden, true);
});
