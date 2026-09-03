rm -rf dist
emcc -O3 \
    -s WASM=1 \
    -s EXPORTED_RUNTIME_METHODS='["cwrap","ccall","HEAP8","HEAPU8","HEAP16","HEAP32","getValue","setValue","UTF8ToString","addFunction","stringToUTF8","lengthBytesUTF8"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS="['_malloc','_free']" \
    -s TOTAL_STACK=32MB \
    -s EXPORT_ES6=1 \
    -s MODULARIZE=1 \
    -s ALLOW_TABLE_GROWTH \
    -s ENVIRONMENT="web,worker" \
    -s SINGLE_FILE=1 \
    -I libraw \
    src/libraw-mini.c \
    libraw/src/*.cpp \
    libraw/src/{decoders,decompressors,demosaic,integration,metadata,tables,utils,x3f}/*.cpp \
    libraw/src/write/{apply_profile.cpp,file_write.cpp,tiff_writer.cpp} \
    libraw/src/preprocessing/{raw2image.cpp,ext_preprocess.cpp,subtract_black.cpp} \
    libraw/src/postprocessing/{aspect_ratio.cpp,dcraw_process.cpp,mem_image.cpp,postprocessing_aux.cpp,postprocessing_utils.cpp,postprocessing_utils_dcrdefs.cpp} \
    -o src/libraw.js

node build.js