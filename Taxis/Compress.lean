/-!
# Response compression

A gzip compressor for API responses, bound to zlib through `bindings/gzip.c`.

Static assets do not come through here: those are compressed once at build time, by
`frontend/scripts/precompress.mjs`, and `serveStatic` just picks the variant the client asked for.
That works because an asset is the same bytes for every request. An API response is not, so
compressing it needs a compressor in the server — and without one the largest thing this server
sends, the issue list, went out as plain JSON.
-/

namespace Taxis

/-- Compress `data` as a gzip stream (RFC 1952). Returns an empty `ByteArray` if zlib refuses,
    which callers read as "send it uncompressed" rather than as a failed request. -/
@[extern "taxis_gzip"]
opaque gzipBytes (data : ByteArray) (level : UInt8) : ByteArray

/-- The compression level responses are built at.

    Six is zlib's default and the point where the curve flattens: on this server's JSON, level 9
    costs several times the CPU for well under a percent of the size. The bytes saved are the whole
    point of this, and by level 6 they are already saved. -/
def gzipLevel : UInt8 := 6

/-- Below this many bytes a response is sent as-is. A gzip stream carries 18 bytes of header and
    trailer before it encodes anything, and a payload this small is one network packet either way,
    so compressing it spends CPU on both ends to save nothing. -/
def compressMinBytes : Nat := 1024

/-- Compress `payload` for a client that accepts gzip, if it is worth it.

    `none` means send the original: either the client did not ask for gzip, or the payload is too
    small to be worth compressing, or zlib produced nothing useful. The last case includes the one
    where the "compressed" form came out no smaller than the input, which happens with short or
    already-dense bodies and would otherwise mean paying for a transformation that added bytes. -/
def gzipIfWorthwhile (payload : String) (acceptsGzip : Bool) : Option ByteArray :=
  if !acceptsGzip then none
  else
    let bytes := payload.toUTF8
    if bytes.size < compressMinBytes then none
    else
      let out := gzipBytes bytes gzipLevel
      if out.isEmpty || out.size ≥ bytes.size then none else some out

end Taxis
