// react-native-gesture-handler's package.json has no `exports` map, so
// `_layout.tsx` deep-imports GestureHandlerRootView directly instead of the
// package's barrel `react-native-gesture-handler` export — the barrel pulls
// in the whole library (~207 KiB) into the root layout, which every screen
// pays for, for a component whose own web implementation is a plain View +
// context provider. See the import site's comment for the full rationale.
//
// TypeScript can't resolve a .d.ts for that deep path on its own (the
// library's generated types live under lib/typescript/, not co-located with
// lib/module/), so this is a minimal ambient declaration mirroring the
// library's own GestureHandlerRootViewProps
// (PropsWithChildren<ViewProps>) — verify this still matches on any
// react-native-gesture-handler version bump.
declare module 'react-native-gesture-handler/lib/module/components/GestureHandlerRootView' {
  import type { ComponentType, PropsWithChildren } from 'react';
  import type { ViewProps } from 'react-native';

  // A type alias, not an empty extending interface: the deep-import module
  // this declares takes exactly ViewProps plus children and adds nothing of
  // its own, and an interface with no members is just a slower way to say
  // that (which @typescript-eslint/no-empty-object-type flags).
  export type GestureHandlerRootViewProps = PropsWithChildren<ViewProps>;

  const GestureHandlerRootView: ComponentType<GestureHandlerRootViewProps>;
  export default GestureHandlerRootView;
}
