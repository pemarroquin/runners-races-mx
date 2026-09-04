// react-dom and react-native-web are both real dependencies of the web build
// (package.json), but neither ships types this project consumes: react-dom's
// live in @types/react-dom, which isn't installed because nothing in src/
// imports react-dom directly — Expo's web entry does. Rather than add a
// dependency for one test, declare the two entry points it touches. The test
// asserts on rendered HTML strings, so it gains nothing from their types.
declare module 'react-dom/server';
declare module 'react-native-web';
