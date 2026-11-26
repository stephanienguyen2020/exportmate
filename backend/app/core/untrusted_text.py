"""Third-party text (news articles, feed titles) is data, never instructions: the news scan
withholds an article that addresses an AI assistant before any model reads it, and fences the
text it places in a prompt. The same patterns as the AI service's guard.js, which applies them
to what the assistant reads."""

import re

# Phrases aimed at a language model rather than a reader. Kept narrow so ordinary trade news
# ("exporters ignored the rules", "acts as a deterrent") is not caught.
_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,30}\b(previous|prior|above|earlier|preceding|original|all|any|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|directions|commands)\b",
        r"\b(system|developer|hidden) prompt\b",
        r"\breveal\b[^.\n]{0,30}\b(your|the|system)\b[^.\n]{0,10}\b(prompt|instructions)\b",
        r"\b(new|updated|additional) instructions?\s*:",
        r"\b(instructions?|note|message) (for|to) (the )?(ai|assistant|chatbot|language model|llm)\b",
        r"\b(from now on,? you (are|will|must)|pretend (to be|you are))\b",
        r"<\|?(im_start|im_end|endoftext)\|?>|\[/?(INST|SYS)\]|</?(system|instructions?)>",
        r"\b(DAN mode|do anything now|developer mode enabled|jailbreak)\b",
        r"\b(send|email|forward|post|upload)\b[^.\n]{0,40}\b(conversation|chat history|system prompt|api key|password|credentials|access token)\b",
    ]
]


def find_injection(text: str | None) -> str | None:
    """The first phrase in `text` that addresses an assistant, or None."""
    for pattern in _PATTERNS:
        found = pattern.search(text or "")
        if found:
            return found.group(0)[:80]
    return None


def as_data(text: str | None) -> str:
    """Fences third-party text for a prompt: angle brackets can't open or close a section."""
    return (text or "").replace("<", "‹").replace(">", "›")
