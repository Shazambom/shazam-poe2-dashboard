; Wrapper for compiling desktop/build/installer.nsh with makensis -V2 without writing an installer.
OutFile "/dev/null"
!include "../../desktop/build/installer.nsh"

Section
  !insertmacro preInit
SectionEnd
