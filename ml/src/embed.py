"""Text embedding of every rated item → data/interim/embeddings.parquet (item_id, embedding).

    uv run python src/embed.py

The model RAG Engine indexes with (text-multilingual-embedding-002, 768 numbers); RAG Engine doesn't
hand its vectors back, so this computes its own. GTA: the State Act title. Article: the headline.
Items already embedded with the same model are kept, so a rerun only embeds new ones.
"""

import os
import time
from pathlib import Path

import pandas as pd
from google import genai
from google.genai import errors, types

from sources import all_articles

ML = Path(__file__).resolve().parent.parent
INTERIM = ML / "data/interim"
OUT = INTERIM / "embeddings.parquet"
PROJECT_ID = os.environ.get("PROJECT_ID", "skilful-scarab-511320-q9")
LOCATION = os.environ.get("RAG_LOCATION", "asia-southeast1")
MODEL = os.environ.get("RAG_EMBED_MODEL", "text-multilingual-embedding-002")
BATCH = 25


def item_texts() -> pd.DataFrame:
    """The headline only, for every source: archive articles have no snippet, and many scan
    snippets just repeat the headline, so headlines keep training and test alike."""
    rated = set(pd.read_csv(ML / "labels/rated.csv")["item_id"])
    gta = pd.read_parquet(INTERIM / "gta.parquet")[["item_id", "title"]]
    articles = all_articles()[["item_id", "title"]]
    texts = pd.concat([gta, articles]).rename(columns={"title": "text"})
    return texts[texts["item_id"].isin(rated)]


def embed_batch(client: genai.Client, texts: list[str]) -> list[list[float]]:
    config = types.EmbedContentConfig(task_type="CLASSIFICATION")
    for attempt in range(6):
        try:
            response = client.models.embed_content(model=MODEL, contents=texts, config=config)
            return [embedding.values for embedding in response.embeddings]
        except errors.ClientError as error:
            if error.code != 429 or attempt == 5:
                raise
            time.sleep(5 * 2**attempt)
    raise RuntimeError("unreachable")


def main() -> None:
    texts = item_texts()
    done = (
        pd.read_parquet(OUT)
        if OUT.exists()
        else pd.DataFrame(columns=["item_id", "embedding", "embedding_model"])
    )
    done = done[done["embedding_model"] == MODEL]
    todo = texts[~texts["item_id"].isin(set(done["item_id"]))]
    client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    vectors = []
    for start in range(0, len(todo), BATCH):
        vectors += embed_batch(client, todo["text"].iloc[start : start + BATCH].str.slice(0, 2000).tolist())
    new = pd.DataFrame({"item_id": todo["item_id"], "embedding": vectors, "embedding_model": MODEL})
    pd.concat([done, new]).to_parquet(OUT, index=False)
    print(f"embedded {len(new)} new items ({len(done) + len(new)} in all) with {MODEL}")


if __name__ == "__main__":
    main()
