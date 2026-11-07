# The JavaScript bridge methods are called by name from the WebView.
-keepclassmembers class io.github.merry8989uk.khata.MainActivity$Bridge {
    public *;
}
-keepattributes JavascriptInterface
