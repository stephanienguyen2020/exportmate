from pydantic import BaseModel


class PubSubMessageIn(BaseModel):
    data: str = ""  # base64 JSON: services/graph_events.change_to_message


class PubSubPushIn(BaseModel):
    """The body of a Pub/Sub push delivery."""

    message: PubSubMessageIn
    subscription: str | None = None
