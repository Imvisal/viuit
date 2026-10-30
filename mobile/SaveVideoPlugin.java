package com.imvisal.viuit;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Saves an exported video straight into the phone gallery (Movies/viuit), in small chunks. */
@CapacitorPlugin(name = "SaveVideo")
public class SaveVideoPlugin extends Plugin {
    private static class Out {
        Uri uri;
        OutputStream os;
    }

    private final Map<String, Out> outs = new HashMap<>();

    @PluginMethod
    public void begin(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT < 29) {
                call.reject("OLD_ANDROID");
                return;
            }
            String name = call.getString("name", "viuit.mp4");
            String mime = call.getString("mime", "video/mp4");
            ContentResolver r = getContext().getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Movies/viuit");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Out o = new Out();
            o.uri = r.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v);
            if (o.uri == null) throw new Exception("The phone would not create the file");
            o.os = r.openOutputStream(o.uri);
            if (o.os == null) throw new Exception("The phone would not open the file");
            String id = UUID.randomUUID().toString();
            outs.put(id, o);
            JSObject ret = new JSObject();
            ret.put("id", id);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void chunk(PluginCall call) {
        try {
            Out o = outs.get(call.getString("id"));
            if (o == null) throw new Exception("Save was not started");
            byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            o.os.write(data);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void finish(PluginCall call) {
        try {
            String id = call.getString("id");
            Out o = outs.remove(id);
            if (o == null) throw new Exception("Save was not started");
            o.os.flush();
            o.os.close();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(o.uri, v, null, null);
            JSObject ret = new JSObject();
            ret.put("uri", o.uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void abort(PluginCall call) {
        try {
            Out o = outs.remove(call.getString("id"));
            if (o != null) {
                try { o.os.close(); } catch (Exception ignored) { }
                getContext().getContentResolver().delete(o.uri, null, null);
            }
        } catch (Exception ignored) { }
        call.resolve();
    }
}
