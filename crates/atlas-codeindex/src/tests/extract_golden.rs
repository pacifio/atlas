//! Per-language extraction, pinned line by line. Each fixture carries the
//! cases the old shallow walk missed (Python decorated defs, TS arrow
//! components and class methods, Go const/var, `macro_rules!`, Rust impl
//! methods named after their type).

use std::time::{Duration, Instant};

use super::{golden, golden_imports};
use crate::{extract, Lang};

fn sym<'a>(ex: &'a extract::Extracted, qn: &str) -> &'a extract::SymbolRec {
    ex.symbols.iter().find(|s| s.qualified_name == qn).unwrap()
}

fn extract_all(rel: &str, src: &str) -> extract::Extracted {
    extract::extract(
        Lang::from_path(rel).unwrap(),
        rel,
        src.as_bytes(),
        Instant::now() + Duration::from_secs(30),
    )
}

const RUST: &str = r#"use std::collections::{HashMap, hash_map::Entry as E};
use crate::store::{self, Store};
use super::*;
extern crate serde as sd;

/// Max widgets.
pub const LIMIT: usize = 10;
static COUNT: u32 = 0;

/// A widget.
/// Second line.
#[derive(Debug)]
pub struct Widget<T> {
    pub id: T,
}

pub enum Mode { On, Off }

pub trait Render {
    fn draw(&self);
    fn name(&self) -> String { String::new() }
}

impl<T> Widget<T> {
    pub fn new(id: T) -> Self {
        fn helper() {}
        Self { id }
    }
    fn private(&self) {}
}

impl<T> Render for Widget<T> {
    fn draw(&self) {}
}

#[macro_export]
macro_rules! make_widget {
    ($id:expr) => { Widget::new($id) };
}

pub type Alias = Widget<u8>;

pub mod inner {
    pub fn deep() {}
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds() {}
}
"#;

#[test]
fn rust_items_impls_macros_and_tests() {
    assert_eq!(
        golden("src/w.rs", RUST),
        [
            "const LIMIT 7-7 pub ^-",
            "static COUNT 8-8 ^-",
            "struct Widget 12-15 pub ^-",
            "enum Mode 17-17 pub ^-",
            "trait Render 19-22 pub ^-",
            "method Render::draw 20-20 pub ^Render",
            "method Render::name 21-21 pub ^Render",
            "impl Widget 24-30 ^-",
            "method Widget::new 25-28 pub ^Widget",
            "method Widget::private 29-29 ^Widget",
            "impl Widget 32-34 ^-",
            "method Widget::draw 33-33 pub ^Widget",
            "macro make_widget 36-39 pub ^-",
            "type Alias 41-41 pub ^-",
            "mod inner 43-45 pub ^-",
            "fn inner::deep 44-44 pub ^inner",
            "mod tests 47-51 test ^-",
            "fn tests::builds 49-50 test ^tests",
        ]
    );
    assert_eq!(
        golden_imports("src/w.rs", RUST),
        [
            "HashMap <- std::collections::HashMap @1",
            "E <- std::collections::hash_map::Entry @1",
            "store <- crate::store @2",
            "Store <- crate::store::Store @2",
            "* <- super @3",
            "sd <- serde @4",
        ]
    );
    let ex = extract_all("src/w.rs", RUST);
    let widget = sym(&ex, "Widget");
    assert_eq!(widget.signature, "pub struct Widget<T>");
    assert_eq!(widget.doc, "A widget.\nSecond line.");
    assert_eq!(
        sym(&ex, "Widget::new").signature,
        "pub fn new(id: T) -> Self"
    );
    assert_eq!(sym(&ex, "LIMIT").signature, "pub const LIMIT: usize = 10");
    assert_eq!(
        sym(&ex, "make_widget").signature,
        "macro_rules! make_widget"
    );
    assert!(!ex.partial);
}

const TSX: &str = r#"import React, { useState as useS } from "react";
import * as path from 'node:path';
import "./side-effect.css";
export { helper as aid } from "./helpers";
export * from "./all";

/** Props for the widget. */
export interface Props { id: string }
export type Alias = Props;
export enum Color { Red }

/** Renders one widget. */
export const Widget = ({ id }: Props) => {
  const [n, setN] = useS(0);
  const inner = () => n;
  return <div onClick={() => setN(n + 1)}>{id}</div>;
};

const LIMIT = 10;
let counter = 0;

export default class Store extends Base {
  private cache = new Map();
  handle = (e: Event) => { this.cache.clear(); };
  /** Loads it. */
  async load(id: string): Promise<void> {}
  #secret() {}
  static create() { return new Store(); }
}

function localOnly(): void {
  function nested() {}
}

export namespace Shapes {
  export function area() { return 1; }
}

describe("x", () => {
  const notIndexed = () => 1;
});
"#;

#[test]
fn tsx_arrow_components_class_members_and_namespaces() {
    assert_eq!(
        golden("web/w.tsx", TSX),
        [
            "interface Props 8-8 pub ^-",
            "type Alias 9-9 pub ^-",
            "enum Color 10-10 pub ^-",
            "fn Widget 13-17 pub ^-",
            "const LIMIT 19-19 ^-",
            "class Store 22-29 pub ^-",
            "method Store.handle 24-24 pub ^Store",
            "method Store.load 26-26 pub ^Store",
            "method Store.#secret 27-27 ^Store",
            "method Store.create 28-28 pub ^Store",
            "fn localOnly 31-33 ^-",
            "namespace Shapes 35-37 pub ^-",
            "fn Shapes.area 36-36 pub ^Shapes",
        ]
    );
    assert_eq!(
        golden_imports("web/w.tsx", TSX),
        [
            "React <- react @1",
            "useS <- react @1",
            "path <- node:path @2",
            " <- ./side-effect.css @3",
            "aid <- ./helpers @4",
            "* <- ./all @5",
        ]
    );
    let ex = extract_all("web/w.tsx", TSX);
    let widget = sym(&ex, "Widget");
    assert_eq!(widget.signature, "const Widget = ({ id }: Props) =>");
    assert_eq!(widget.doc, "Renders one widget.");
    assert_eq!(
        sym(&ex, "Store.load").signature,
        "async load(id: string): Promise<void>"
    );
    assert_eq!(sym(&ex, "Store.load").doc, "Loads it.");
    // `.js` parses with the TSX grammar, JSX included.
    assert_eq!(
        golden("a.js", "export function App() { return <div>hi</div>; }\n"),
        ["fn App 1-1 pub ^-"]
    );
}

const PY: &str = r#"import os
import a.b as ab, c.d
from typing import List, Optional as Opt
from . import sibling
from ..pkg.mod import *

def build(x: int) -> int:
    """Build it.

    More text.
    """
    def helper():
        pass
    return 1

@app.route("/")
@cached
def index():
    return "hi"

class Widget(Base):
    """A widget."""

    @property
    def name(self) -> str:
        return ""

    def _private(self):
        pass

    class Inner:
        def deep(self):
            pass

if TYPE_CHECKING:
    from x import Y

    def guarded():
        pass
"#;

#[test]
fn python_decorated_defs_methods_and_docstrings() {
    assert_eq!(
        golden("pkg/w.py", PY),
        [
            "fn build 7-14 pub ^-",
            "fn index 16-19 pub ^-",
            "class Widget 21-33 pub ^-",
            "method Widget.name 24-26 pub ^Widget",
            "method Widget._private 28-29 ^Widget",
            "class Widget.Inner 31-33 pub ^Widget",
            "method Widget.Inner.deep 32-33 pub ^Widget.Inner",
            "fn guarded 38-39 pub ^-",
        ]
    );
    assert_eq!(
        golden_imports("pkg/w.py", PY),
        [
            "os <- os @1",
            "ab <- a.b @2",
            "c <- c.d @2",
            "List <- typing @3",
            "Opt <- typing @3",
            "sibling <- . @4",
            "* <- ..pkg.mod @5",
            "Y <- x @36",
        ]
    );
    let ex = extract_all("pkg/w.py", PY);
    assert_eq!(sym(&ex, "build").doc, "Build it.\n\nMore text.");
    assert_eq!(sym(&ex, "build").signature, "def build(x: int) -> int");
    // The decorated range starts at the first decorator; the signature does not.
    assert_eq!(sym(&ex, "index").signature, "def index()");
    // Test files mark every symbol.
    assert_eq!(
        golden("tests/test_w.py", "def test_a():\n    pass\n"),
        ["fn test_a 1-2 pub test ^-"]
    );
}

const GO: &str = r#"package main

import (
	"fmt"
	f "net/http"
	_ "embed"
)

// Limit is the cap.
const Limit = 10

const (
	A, B = 1, 2
	c    = 3
)

var defaultName = "x"

// Widget is a thing.
type Widget struct {
	ID int
}

type Render interface{ Draw() }

type Alias = Widget

// Build makes one.
func Build() *Widget { return nil }

func (w *Widget) Draw() {}

func (w Pair[K, V]) Get(k K) V { var v V; return v }
"#;

#[test]
fn go_consts_vars_types_and_receivers() {
    assert_eq!(
        golden("cmd/w.go", GO),
        [
            "const Limit 10-10 pub ^-",
            "const A 13-13 pub ^-",
            "const B 13-13 pub ^-",
            "const c 14-14 ^-",
            "var defaultName 17-17 ^-",
            "struct Widget 20-22 pub ^-",
            "interface Render 24-24 pub ^-",
            "type Alias 26-26 pub ^-",
            "fn Build 29-29 pub ^-",
            "method Widget.Draw 31-31 pub ^-",
            "method Pair.Get 33-33 pub ^-",
        ]
    );
    assert_eq!(
        golden_imports("cmd/w.go", GO),
        ["fmt <- fmt @4", "f <- net/http @5", "_ <- embed @6"]
    );
    let ex = extract_all("cmd/w.go", GO);
    assert_eq!(sym(&ex, "Widget").signature, "type Widget struct");
    assert_eq!(sym(&ex, "Widget").doc, "Widget is a thing.");
    assert_eq!(sym(&ex, "Widget.Draw").signature, "func (w *Widget) Draw()");
}

#[test]
fn malformed_source_is_partial_not_a_panic() {
    let ex = extract_all("b.rs", "fn ((( {\npub struct Ok;\n");
    assert!(ex.partial);
    let empty = extract_all("e.rs", "");
    assert!(empty.symbols.is_empty() && !empty.partial);
}

#[test]
fn parse_past_deadline_is_abandoned() {
    let big = "pub fn a() { let x = 1; }\n".repeat(20_000);
    let ex = extract::extract(Lang::Rust, "big.rs", big.as_bytes(), Instant::now());
    assert!(ex.timed_out && ex.partial && ex.symbols.is_empty());
    // The thread's parser was reset: the next parse on it succeeds.
    assert_eq!(golden("ok.rs", "fn ok() {}\n"), ["fn ok 1-1 ^-"]);
}
