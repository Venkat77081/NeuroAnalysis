"""Part uploads for the local storage backend (decision 019). Same role as an S3 presigned URL."""

from fastapi import APIRouter, HTTPException, Request, Response, status

from app.storage import LocalStorage, get_storage

router = APIRouter(prefix="/storage", tags=["storage"])


@router.put("/upload/{upload_id}/{number}")
async def put_part(upload_id: str, number: int, exp: int, sig: str, request: Request) -> Response:
    st = get_storage()
    if not isinstance(st, LocalStorage):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not available")
    if not 1 <= number <= 10000 or not st.verify(upload_id, number, exp, sig):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "bad or expired signature")
    try:
        etag = st.write_part(upload_id, number, await request.body())
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown upload") from exc
    return Response(status_code=200, headers={"ETag": f'"{etag}"'})
