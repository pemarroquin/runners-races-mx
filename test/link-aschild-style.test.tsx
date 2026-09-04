// The one component-level test in this suite, and it exists because a
// styling bug shipped to production that nothing else here could catch.
//
// `<Link asChild><Pressable style={({pressed}) => [...]}>` renders the
// Pressable through expo-router's Slot, which wraps Radix's. Radix merges the
// style prop with `{ ...slotStyle, ...childStyle }` — and object-spreading a
// FUNCTION yields `{}`, because a function has no enumerable own properties.
// The row's entire style silently became empty: no flexDirection, no
// padding, no alignment. On screen that is not a subtle regression, it is
// icon/label/hint/chevron each on their own line flush left, which reads as
// a broken component rather than a lost style. tsc, ESLint and every other
// test in this suite pass on it.
//
// So the Settings list keeps its layout on an inner View and takes `pressed`
// from the children-as-function form (see (tabs)/settings/index.tsx). This
// pins that contract down. It renders through react-native-web + react-dom,
// which the web build already depends on — it is NOT a general component
// testing setup, and the note at the top of vitest.config.ts still stands.
import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Slot as RadixSlot } from '@radix-ui/react-slot';
import { Pressable, View, StyleSheet } from 'react-native-web';

// expo-router's Slot shim, reproduced from build/ui/Slot.js: it flattens the
// Slot's own style, then hands off to Radix.
const Slot = React.forwardRef(function RNSlotHOC({ style, ...props }: any, ref: any) {
  return <RadixSlot ref={ref} {...props} style={StyleSheet.flatten(style)} />;
});

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
});

/** What `<Link href asChild>` does on web: render the child through Slot with
 *  the link's own props — including a `style` that is undefined. */
const asLink = (child: React.ReactElement) =>
  renderToStaticMarkup(
    <Slot href="/settings/profile" style={undefined}>
      {child}
    </Slot>,
  );

describe('Link asChild + Pressable', () => {
  it('keeps the layout when it lives on an inner View', () => {
    const html = asLink(
      <Pressable accessibilityRole="link">
        {({ pressed }: any) => <View style={[s.row, pressed && { opacity: 0.5 }]} />}
      </Pressable>,
    );
    // react-native-web emits atomic classes rather than inline styles, so
    // assert on those: r-flexDirection / r-alignItems / r-paddingInline.
    expect(html).toContain('r-flexDirection');
    expect(html).toContain('r-alignItems');
    expect(html).toContain('r-paddingInline');
  });

  it('loses it entirely when the Pressable takes a style function', () => {
    const html = asLink(
      <Pressable style={({ pressed }: any) => [s.row, pressed && { opacity: 0.5 }]}>
        <View />
      </Pressable>,
    );
    // Not a partial loss — the child renders with no layout classes at all.
    expect(html).not.toContain('r-flexDirection');
    expect(html).not.toContain('r-alignItems');
    expect(html).not.toContain('r-paddingInline');
  });
});
