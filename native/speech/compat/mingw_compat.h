/* mingw-w64 11 (Ubuntu 24.04) lacks THREAD_POWER_THROTTLING_STATE, which ggml-cpu uses on
   Windows 8+. Same layout as the Windows SDK's processthreadsapi.h (ULONG is 32-bit on Windows).
   Force-included into the C sources of the Windows cross build only. */
#if defined(__MINGW32__)
#include <_mingw.h>
#if __MINGW64_VERSION_MAJOR <= 11 && !defined(THREAD_POWER_THROTTLING_CURRENT_VERSION)
#define THREAD_POWER_THROTTLING_CURRENT_VERSION 1
#define THREAD_POWER_THROTTLING_EXECUTION_SPEED 0x1
#define THREAD_POWER_THROTTLING_VALID_FLAGS (THREAD_POWER_THROTTLING_EXECUTION_SPEED)
typedef struct _THREAD_POWER_THROTTLING_STATE {
  unsigned long Version;
  unsigned long ControlMask;
  unsigned long StateMask;
} THREAD_POWER_THROTTLING_STATE;
#endif
#endif
