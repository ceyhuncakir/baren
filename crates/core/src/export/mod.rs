//! Document exporters: [`json`] (prints like the JS
//! `JSON.stringify(toSnapshot(doc), null, 2)`) and [`html`].

pub mod assets;
pub(crate) mod base64;
pub(crate) mod css;
pub(crate) mod escape;
pub mod html;
pub mod json;
pub(crate) mod svg;
