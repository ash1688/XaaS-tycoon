// Company name filter. Pure: no I/O, and a small word list kept here.
// The words are ROT13-encoded so the source reads clean in a classroom; decodeList undoes it.

/** Caught anywhere inside a word, e.g. inside compounds. Only words no ordinary word contains. */
const ANYWHERE = decodeList(
  "shpx fuvg jnaxre obyybpx onfgneq gjng oryyraq nffubyr nefrubyr qvpxurnq avttre snttbg juber cravf intvan",
);

/**
 * Caught only as a whole word (or its plural), because ordinary words contain them:
 * Scunthorpe, class, assessment, Essex, cocktail, scrap, Arsenal, title...
 */
const WHOLE_WORD = decodeList(
  "nff nefr pbpx qvpx cevpx cvff cvffrq penc penccl phag gvg frk frkl phz jnax gbffre fyhg chffl obbo xabo cbea avttn snt funt",
);

/** Leetspeak and look-alike symbols. 1 can stand for i or l, so both readings are checked. */
const LOOKALIKES: Record<string, string> = { "0": "o", "3": "e", "4": "a", "@": "a", "5": "s", $: "s", "!": "i" };

function decodeList(encoded: string): string[] {
  return encoded
    .split(" ")
    .map((w) => w.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)));
}

/** The name as lowercase letter-only words, with runs of single letters ("f u n") joined back up. */
function words(name: string, one: "i" | "l"): string[] {
  const tokens = name
    .normalize("NFKD") // also turns full-width characters into plain ones
    .replace(/\p{M}/gu, "") // accents
    .toLowerCase()
    .split(/\s+/)
    .map((token) =>
      [...token]
        .map((c) => (c === "1" ? one : (LOOKALIKES[c] ?? c)))
        .join("")
        .replace(/[^a-z]/g, ""),
    )
    .filter(Boolean);
  const joined: string[] = [];
  let inRun = false;
  for (const token of tokens) {
    if (token.length === 1 && inRun) joined[joined.length - 1] += token;
    else joined.push(token);
    inRun = token.length === 1;
  }
  return joined;
}

function isProfaneWord(word: string): boolean {
  return (
    ANYWHERE.some((bad) => word.includes(bad)) ||
    WHOLE_WORD.some((bad) => word === bad || word === `${bad}s` || word === `${bad}es`)
  );
}

/** False if the name contains a word on the list, even disguised with spacing, punctuation or leetspeak. */
export function isNameAllowed(name: string): boolean {
  return !(["i", "l"] as const).some((one) => words(name, one).some(isProfaneWord));
}
