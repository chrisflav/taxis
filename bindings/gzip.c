// gzip compression for API responses, over zlib.
//
// The static assets are compressed once at build time (frontend/scripts/precompress.mjs) because
// they never change between requests. API responses are generated per request, so they need a
// compressor in the server — the JSON the issue list returns is by a wide margin the largest thing
// this server sends, and it was going out as plain bytes.
//
// Nothing here is streaming: a response is already a single string in memory by the time it gets
// this far, so one deflate call over the whole buffer is the entire job.

#include <lean/lean.h>
#include <zlib.h>
#include <limits.h>
#include <string.h>

// Compress `input` as a gzip stream (RFC 1952) at `level`.
//
// Returns an empty ByteArray if compression fails for any reason, which the caller reads as "send
// it uncompressed" — a response that cannot be compressed is not a failed request.
//
// `input` is an owned reference (the default for an `@[extern]` parameter), so it is released here.
LEAN_EXPORT lean_obj_res taxis_gzip(lean_obj_arg input, uint8_t level) {
  size_t in_len = lean_sarray_size(input);
  const uint8_t *in = lean_sarray_cptr(input);

  // zlib counts bytes in `uInt`. Responses are orders of magnitude below this; the check is here so
  // that if one ever were not, it degrades to sending the response uncompressed.
  if (in_len > (size_t)UINT_MAX) {
    lean_dec_ref(input);
    return lean_alloc_sarray(1, 0, 0);
  }

  z_stream zs;
  memset(&zs, 0, sizeof(zs));
  // 15 window bits, +16 to select the gzip wrapper rather than zlib's own.
  if (deflateInit2(&zs, level, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
    lean_dec_ref(input);
    return lean_alloc_sarray(1, 0, 0);
  }

  // `deflateBound` is an upper bound for a single-call deflate, so one output buffer suffices and
  // there is no grow-and-retry loop to get wrong.
  size_t cap = deflateBound(&zs, (uLong)in_len);
  lean_object *out = lean_alloc_sarray(1, cap, cap);

  zs.next_in = (Bytef *)in;
  zs.avail_in = (uInt)in_len;
  zs.next_out = (Bytef *)lean_sarray_cptr(out);
  zs.avail_out = (uInt)cap;

  int rc = deflate(&zs, Z_FINISH);
  size_t produced = (rc == Z_STREAM_END) ? cap - zs.avail_out : 0;
  deflateEnd(&zs);
  lean_dec_ref(input);

  // On failure this is the same empty array the error paths above return; the buffer it over-
  // allocated is freed with it.
  lean_sarray_set_size(out, produced);
  return out;
}
