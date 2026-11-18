# An answer given in one surface must close the detail another surface shows

- **Trap:** After Approve Once in the Inbox list, the shell's "Authorization Required" detail stayed on screen, showing a request that was already answered. The screenshot from the 1920×1080 run showed it.
- **Root Cause:** The shell's detail buttons cleared the selected approval, but the Inbox's own buttons only collapsed its row. The two surfaces shared state, and only one path cleared it.
- **Rule:** When one action can be taken from two surfaces, the action's completion callback must clear every shared selection, whichever surface started it. The Inbox takes an `onDecided` prop, and the shell wires it to clear the selection and reload the list.
