// react-dom is a real dependency of the web build (Expo's web entry renders
// through it), but its types live in @types/react-dom, which isn't
// installed. pocket-screen.web.tsx needs exactly one function from it, so
// that one is declared here rather than adding a dependency for it.
declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react';
  export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactPortal;
}
