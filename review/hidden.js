// Characters that do not show, or that change how the text around them shows: control
// characters (but tab and line feed), format characters such as the ones that reverse
// direction or join and hide, private-use and unassigned code points, line and paragraph
// separators, the blank "filler" letters, and variation selectors.
//
// The terminal has the same rule in src/render.ts. A test holds the two together over every
// code point.
const pattern = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]|͏|ᅟ|ᅠ|ㅤ|ﾠ|\p{Variation_Selector}/u;

/** Whether a character, given as a string of one code point, is one a reader would not see for what it is. */
export function hidden(character) {
  return character !== "\t" && character !== "\n" && pattern.test(character);
}
