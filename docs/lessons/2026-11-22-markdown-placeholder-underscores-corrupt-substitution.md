# Placeholder underscores in token extraction corrupt markdown substitution

- **Trap:** When parsing markdown by extracting fenced code blocks and inline code into placeholders like `%%INLINE_CODE_${idx}%%` and `%%CODE_BLOCK_${idx}%%`, the subsequent italic formatting regex (`_([^_\\n]+)_`) matched the underscores inside the placeholder itself, producing `%%INLINE<em>CODE</em>${idx}%%`. This prevented placeholder replacement, outputting raw broken tokens to the user.
- **Root Cause:** Underscores are valid markdown delimiters for italics. Using alphanumeric or underscore characters in temporary substitution markers exposes them to inline markdown transformations.
- **Rule:** Use non-alphanumeric control characters (such as `\x00CODEBLOCK${idx}\x00` and `\x00INLINE${idx}\x00`) for temporary extraction tokens so that standard markdown formatting rules cannot match or transform token identifiers.
