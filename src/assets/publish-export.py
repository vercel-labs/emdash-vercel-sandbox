import ctypes
import errno
import json
import os
import sys


def publish(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(os.fsencode(source), os.fsencode(destination), 4)
    elif sys.platform == "linux" and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    else:
        raise OSError(errno.ENOTSUP, "Atomic export requires macOS renamex_np or Linux renameat2")
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Expected source and destination")
        publish(sys.argv[1], sys.argv[2])
    except (OSError, ValueError) as error:
        code = errno.errorcode.get(getattr(error, "errno", None), "EINVAL")
        print(json.dumps({"code": code, "message": str(error)}), file=sys.stderr)
        sys.exit(1)
