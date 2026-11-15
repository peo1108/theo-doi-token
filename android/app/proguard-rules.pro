# kotlinx.serialization: giữ lớp @Serializable và serializer sinh ra
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class vn.peo.ccremote.**$$serializer { *; }
-keepclassmembers class vn.peo.ccremote.** {
    *** Companion;
}
-keepclasseswithmembers class vn.peo.ccremote.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp / Okio (thư viện tự mang quy tắc; chỉ tắt cảnh báo các lớp tuỳ chọn)
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
