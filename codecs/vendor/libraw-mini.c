#include <stdlib.h> // required for malloc definition
#include "emscripten.h"

#include "libraw/libraw.h"


EMSCRIPTEN_KEEPALIVE
const char* version() {
    return libraw_version();
}

EMSCRIPTEN_KEEPALIVE
int versionNumber() {
    return libraw_versionNumber();
}

EMSCRIPTEN_KEEPALIVE
libraw_data_t* init(unsigned int flags){
    return libraw_init(flags);
}

EMSCRIPTEN_KEEPALIVE
void close(libraw_data_t* lr){
    return libraw_close(lr);
}

EMSCRIPTEN_KEEPALIVE
void recycle(libraw_data_t* lr){
    return libraw_recycle(lr);
}


EMSCRIPTEN_KEEPALIVE
int open_buffer(libraw_data_t* lr, uint8_t* buffer, int size) {
    return libraw_open_buffer(lr, buffer, size);
}

EMSCRIPTEN_KEEPALIVE
libraw_processed_image_t* get_thumb(libraw_data_t* lr) {
    int error = libraw_unpack_thumb(lr);
    if(!error) {
        return libraw_dcraw_make_mem_thumb(lr,NULL);
    } else {
        return NULL;
    }
}

typedef void (*Callback)(int arg, const char* msg);
static Callback callback;
static int count;
int callback_func(void *data,enum LibRaw_progress p,int iteration, int expected)
{
    const char* msg = libraw_strprogress(p);
    (*callback)(count++,msg);
    //printf("Callback: %s  pass %d of %d\n",msg,iteration,expected);
    return 0;
}


EMSCRIPTEN_KEEPALIVE
libraw_processed_image_t* get_image(libraw_data_t* lr, Callback cb) {
    callback = cb;
    count=0;
    libraw_set_progress_handler(lr, callback_func, NULL);

    int error = libraw_unpack(lr);
    if(!error) {
        int error = libraw_dcraw_process(lr);
        libraw_set_progress_handler(lr, NULL, NULL);
        if(!error) {
            return libraw_dcraw_make_mem_image(lr,NULL);
        } else {
            return NULL;
        }
    } else {
        return NULL;    
    }
}

EMSCRIPTEN_KEEPALIVE
void clear_image(libraw_processed_image_t* img) {
    libraw_dcraw_clear_mem(img);
}


EMSCRIPTEN_KEEPALIVE
libraw_iparams_t * get_idata(libraw_data_t* lr) {
    //return libraw_get_iparams(lr);
    return &(lr->idata);
}
EMSCRIPTEN_KEEPALIVE
libraw_image_sizes_t * get_sizes(libraw_data_t* lr) {
    return &(lr->sizes);
}
EMSCRIPTEN_KEEPALIVE
libraw_imgother_t * get_imgother(libraw_data_t* lr) {
    return &(lr->other);
}

EMSCRIPTEN_KEEPALIVE
void set_param(libraw_data_t* lr, char* param, int value) {
    //printf("set_param: %s  value %d\n",param, value);

    // -H  : highlight mode (0..9) 0=default.  (0=clip, 1=unclip, 2=blend, 3+=rebuild).
    if(strcmp(param,"highlight")==0)
        lr->params.highlight = value;
    
    // -a  : auto white balance false=default
    else if(strcmp(param,"use_auto_wb")==0)
        lr->params.use_auto_wb = value;

    // -w  : camera's recorded WB false=default
    else if(strcmp(param,"use_camera_wb")==0)
        lr->params.use_camera_wb = value;

    // -o  : output colorspace (0..8) (0=raw,1=sRGB,2=Adobe, 3=Wide, 4=ProPhoto, 5=XYZ, 6=ACES, 7=DCI-P3, 8=Rec. 2020))
    // 1 = default sRGB
    else if(strcmp(param,"output_color")==0)
        lr->params.output_color = value;

    // -4  : 8 or 16 bits per sample 8=default
    else if(strcmp(param,"output_bps")==0)
        lr->params.output_bps = value;

    // -T  : output TIFF if true, else PPM  false=default
    else if(strcmp(param,"output_tiff")==0)
        lr->params.output_tiff = value;

    // -t  : flip/rotate (0..7, default=-1 means use RAW value)
    else if(strcmp(param,"user_flip")==0)
        lr->params.user_flip = value;

    // -q  : interpolation quality (0..12) 3=default
    // 0=linear, 1=VNG, 2=PPG, 3=AHD, 4=DCB, 11=DHT, 12=Modified AHD interpolation (by Anton Petrusevich)
    else if(strcmp(param,"user_qual")==0)
        lr->params.user_qual = value;

    // -k  : user black level -1=default
    else if(strcmp(param,"user_black")==0)
        lr->params.user_black = value;

    // -S  : user saturation level 0=default
    else if(strcmp(param,"user_sat")==0)
        lr->params.user_sat = value;

    // -W  : don't apply auto brightness false=default
    else if(strcmp(param,"no_auto_bright")==0)
        lr->params.no_auto_bright = value;

}
