# ggml drops the "lib" prefix of its static libraries on Windows (ggml.a), but rustc's
# windows-gnu linker looks for libggml.a. Put the prefix back once the targets exist.
if (MINGW)
  cmake_language(DEFER DIRECTORY ${CMAKE_SOURCE_DIR} CALL set_target_properties ggml ggml-base ggml-cpu PROPERTIES PREFIX "lib")
endif()
