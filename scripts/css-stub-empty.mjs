/**
 * The module every stylesheet import resolves to under `node --test`
 * (MONEY-1192). Deliberately empty — see css-stub-hooks.mjs.
 *
 * A default export is provided because CSS-modules-style imports
 * (`import styles from "./x.module.css"`) expect one; it is an empty object, so
 * `styles.foo` is undefined rather than a crash. Plain side-effect imports
 * (`import "./x.css"`) ignore it.
 */
export default {};
