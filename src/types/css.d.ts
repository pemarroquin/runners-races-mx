// Ambient declarations so TypeScript accepts CSS imports handled by Metro.
declare module '*.css';

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
