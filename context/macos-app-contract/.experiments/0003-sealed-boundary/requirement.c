#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    if (argc < 3) return 64;
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)argv[2],strlen(argv[2]),false);
    SecStaticCodeRef code = NULL;
    OSStatus status = SecStaticCodeCreateWithPath(url,kSecCSDefaultFlags,&code);
    CFRelease(url);
    if (status) { printf("create=%d\n",(int)status); return 2; }
    if (!strcmp(argv[1],"hash")) {
        CFDictionaryRef info = NULL;
        status=SecCodeCopySigningInformation(code,kSecCSSigningInformation,&info);
        if (!status) {
            CFDataRef hash=CFDictionaryGetValue(info,kSecCodeInfoUnique);
            if (!hash || CFGetTypeID(hash)!=CFDataGetTypeID()) status=errSecParam;
            else { const UInt8 *bytes=CFDataGetBytePtr(hash); for(CFIndex i=0;i<CFDataGetLength(hash);i++) printf("%02x",bytes[i]); puts(""); }
            CFRelease(info);
        }
    } else if (!strcmp(argv[1],"check") && argc==4) {
        CFStringRef string=CFStringCreateWithCString(NULL,argv[3],kCFStringEncodingUTF8);
        SecRequirementRef requirement=NULL;
        status=SecRequirementCreateWithString(string,kSecCSDefaultFlags,&requirement);
        CFRelease(string);
        printf("compiled=%d ",(int)status);
        if (!status) { status=SecStaticCodeCheckValidity(code,kSecCSStrictValidate|kSecCSCheckNestedCode|kSecCSNoNetworkAccess,requirement); CFRelease(requirement); }
        printf("validity=%d\n",(int)status);
    } else status=errSecParam;
    CFRelease(code);
    return status ? 1 : 0;
}
