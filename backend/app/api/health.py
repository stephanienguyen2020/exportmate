from fastapi import APIRouter

from app.schemas.common import SuccessResponse, success_response

router = APIRouter(tags=["health"])


@router.get("/health", response_model=SuccessResponse[dict])
def health_check():
    return success_response({"status": "ok"})
