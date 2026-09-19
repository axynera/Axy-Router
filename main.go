package main

import (
 "crypto/hmac"
 "crypto/rand"
 "crypto/sha256"
 "database/sql"
 "encoding/hex"
 "encoding/json"
 "io"
 "log"
 "net/http"
 "os"
 "strings"
 "time"
 _ "modernc.org/sqlite"
)

type Server struct{db *sql.DB; pin,secret string}

func main(){
 os.MkdirAll("data",0755)
 db,err:=sql.Open("sqlite","file:data/axy-router.db?_pragma=journal_mode(WAL)");if err!=nil{log.Fatal(err)}
 defer db.Close()
 _,err=db.Exec("CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,base_url TEXT NOT NULL,api_key TEXT NOT NULL,model TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,api_type TEXT NOT NULL DEFAULT 'openai')")
 if err!=nil{log.Fatal(err)}
 // Migrate databases created by v1.0.0.
 db.Exec("ALTER TABLE providers ADD COLUMN api_type TEXT NOT NULL DEFAULT 'openai'")
 s:=&Server{db:db,pin:getenv("AXY_PIN","123456"),secret:getenv("SESSION_SECRET","change-me")}
 mux:=http.NewServeMux()
 mux.HandleFunc("/",s.home);mux.HandleFunc("/providers",s.providerPage);mux.HandleFunc("/login",s.login);mux.HandleFunc("/logout",s.logout)
 mux.HandleFunc("/api/health",s.health);mux.HandleFunc("/api/providers",s.providers);mux.HandleFunc("/api/providers/test",s.testProvider)
 mux.HandleFunc("/v1/models",s.models);mux.HandleFunc("/v1/chat/completions",s.chat)
 port:=getenv("PORT","3000");log.Printf("Axy Router listening on :%s",port);log.Fatal(http.ListenAndServe(":"+port,logging(mux)))
}
func getenv(k,d string)string{if v:=os.Getenv(k);v!=""{return v};return d}
func(s *Server)sign(v string)string{h:=hmac.New(sha256.New,[]byte(s.secret));h.Write([]byte(v));return hex.EncodeToString(h.Sum(nil))}
func(s *Server)newSession()string{b:=make([]byte,24);rand.Read(b);v:=hex.EncodeToString(b);return v+"."+s.sign(v)}
func(s *Server)authed(r *http.Request)bool{c,e:=r.Cookie("axy_session");if e!=nil{return false};p:=strings.Split(c.Value,".");return len(p)==2&&hmac.Equal([]byte(p[1]),[]byte(s.sign(p[0])))}
func(s *Server)home(w http.ResponseWriter,r *http.Request){if !s.authed(r){http.Redirect(w,r,"/login",302);return};dashboard(w)}
func(s *Server)login(w http.ResponseWriter,r *http.Request){if r.Method=="POST"{r.ParseForm();if r.FormValue("pin")!=s.pin{loginPage(w,"PIN salah.");return};http.SetCookie(w,&http.Cookie{Name:"axy_session",Value:s.newSession(),Path:"/",HttpOnly:true,SameSite:http.SameSiteLaxMode,MaxAge:86400});http.Redirect(w,r,"/",302);return};loginPage(w,"")}
func(s *Server)logout(w http.ResponseWriter,r *http.Request){http.SetCookie(w,&http.Cookie{Name:"axy_session",Path:"/",MaxAge:-1});http.Redirect(w,r,"/login",302)}
func(s *Server)health(w http.ResponseWriter,r *http.Request){jsonOut(w,200,map[string]any{"ok":true,"name":"Axy Router","version":"1.0.0"})}

func(s *Server)providers(w http.ResponseWriter,r *http.Request){
 if !s.authed(r){jsonOut(w,401,map[string]string{"error":"Unauthorized"});return}
 if r.Method=="GET"{
  rows,e:=s.db.Query("SELECT id,name,base_url,model,enabled,api_type FROM providers ORDER BY id");if e!=nil{jsonOut(w,500,map[string]string{"error":e.Error()});return};defer rows.Close()
  out:=[]any{};for rows.Next(){var id,en int;var n,b,m,t string;if rows.Scan(&id,&n,&b,&m,&en,&t)==nil{out=append(out,map[string]any{"id":id,"name":n,"base_url":b,"model":m,"enabled":en==1,"api_type":t})}}
  jsonOut(w,200,map[string]any{"providers":out});return
 }
 if r.Method=="POST"{
  var b struct{Name string `json:"name"`;BaseURL string `json:"base_url"`;APIKey string `json:"api_key"`;Model string `json:"model"`;APIType string `json:"api_type"`}
  if json.NewDecoder(r.Body).Decode(&b)!=nil||b.Name==""||b.BaseURL==""||b.APIKey==""||b.Model==""{jsonOut(w,400,map[string]string{"error":"name, base_url, api_key and model are required"});return}
  b.APIType=strings.ToLower(strings.TrimSpace(b.APIType));if b.APIType!="anthropic"{b.APIType="openai"}
  x,e:=s.db.Exec("INSERT INTO providers(name,base_url,api_key,model,api_type) VALUES(?,?,?,?,?)",b.Name,strings.TrimRight(b.BaseURL,"/"),b.APIKey,b.Model,b.APIType);if e!=nil{jsonOut(w,500,map[string]string{"error":e.Error()});return};id,_:=x.LastInsertId();jsonOut(w,200,map[string]any{"id":id});return
 }
 jsonOut(w,405,map[string]string{"error":"method not allowed"})
}

func(s *Server)testProvider(w http.ResponseWriter,r *http.Request){
 if !s.authed(r){jsonOut(w,401,map[string]string{"error":"Unauthorized"});return}
 if r.Method!="POST"{jsonOut(w,405,map[string]string{"error":"method not allowed"});return}
 var b struct{ID int `json:"id"`};if json.NewDecoder(r.Body).Decode(&b)!=nil||b.ID<1{jsonOut(w,400,map[string]string{"error":"id is required"});return}
 var base,key,model,typ string;var enabled int
 e:=s.db.QueryRow("SELECT base_url,api_key,model,api_type,enabled FROM providers WHERE id=?",b.ID).Scan(&base,&key,&model,&typ,&enabled)
 if e==sql.ErrNoRows{jsonOut(w,404,map[string]string{"error":"provider not found"});return};if e!=nil{jsonOut(w,500,map[string]string{"error":"provider lookup failed"});return};if enabled==0{jsonOut(w,400,map[string]string{"error":"provider is disabled"});return}
 client:=&http.Client{Timeout:20*time.Second}
 if typ=="anthropic"{
  payload:=map[string]any{"model":model,"max_tokens":8,"messages":[]map[string]string{{"role":"user","content":"Reply with OK"}}}
  raw,_:=json.Marshal(payload);req,e:=http.NewRequest("POST",strings.TrimRight(base,"/")+"/messages",strings.NewReader(string(raw)));if e!=nil{jsonOut(w,502,map[string]string{"error":"request failed"});return}
  req.Header.Set("Content-Type","application/json");req.Header.Set("x-api-key",key);req.Header.Set("anthropic-version","2023-06-01")
  resp,e:=client.Do(req);if e!=nil{jsonOut(w,502,map[string]string{"error":"provider request failed"});return};defer resp.Body.Close()
  if resp.StatusCode<200||resp.StatusCode>=300{data,_:=io.ReadAll(io.LimitReader(resp.Body,2048));jsonOut(w,resp.StatusCode,map[string]any{"ok":false,"error":string(data)});return}
  jsonOut(w,200,map[string]any{"ok":true,"provider":"anthropic","model":model});return
 }
 payload:=map[string]any{"model":model,"messages":[]map[string]string{{"role":"user","content":"Reply with OK"}}}
 raw,_:=json.Marshal(payload);req,e:=http.NewRequest("POST",strings.TrimRight(base,"/")+"/chat/completions",strings.NewReader(string(raw)));if e!=nil{jsonOut(w,502,map[string]string{"error":"request failed"});return}
 req.Header.Set("Content-Type","application/json");req.Header.Set("Authorization","Bearer "+key)
 resp,e:=client.Do(req);if e!=nil{jsonOut(w,502,map[string]string{"error":"provider request failed"});return};defer resp.Body.Close()
 if resp.StatusCode<200||resp.StatusCode>=300{data,_:=io.ReadAll(io.LimitReader(resp.Body,2048));jsonOut(w,resp.StatusCode,map[string]any{"ok":false,"error":string(data)});return}
 jsonOut(w,200,map[string]any{"ok":true,"provider":"openai","model":model})
}

func(s *Server)models(w http.ResponseWriter,r *http.Request){rows,e:=s.db.Query("SELECT name,model FROM providers WHERE enabled=1");if e!=nil{jsonOut(w,500,map[string]string{"error":e.Error()});return};defer rows.Close();data:=[]any{};for rows.Next(){var n,m string;if rows.Scan(&n,&m)==nil{data=append(data,map[string]any{"id":m,"object":"model","owned_by":n})}};jsonOut(w,200,map[string]any{"object":"list","data":data})}

func(s *Server)chat(w http.ResponseWriter,r *http.Request){
 body,e:=io.ReadAll(r.Body);if e!=nil{jsonOut(w,400,map[string]string{"error":"invalid body"});return}
 var q struct{Model string `json:"model"`;Messages []map[string]any `json:"messages"`;MaxTokens int `json:"max_tokens"`;Stream bool `json:"stream"`}
 if json.Unmarshal(body,&q)!=nil||q.Model==""{jsonOut(w,400,map[string]string{"error":"model is required"});return}
 var base,key,typ string;e=s.db.QueryRow("SELECT base_url,api_key,api_type FROM providers WHERE enabled=1 AND model=? LIMIT 1",q.Model).Scan(&base,&key,&typ);if e==sql.ErrNoRows{jsonOut(w,404,map[string]string{"error":"model not configured"});return};if e!=nil{jsonOut(w,500,map[string]string{"error":"provider lookup failed"});return}
 if typ=="anthropic"{s.chatAnthropic(w,r,q.Model,q.Messages,q.MaxTokens,q.Stream,base,key);return}
 req,e:=http.NewRequestWithContext(r.Context(),"POST",strings.TrimRight(base,"/")+"/chat/completions",strings.NewReader(string(body)));if e!=nil{jsonOut(w,502,map[string]string{"error":"request failed"});return};req.Header.Set("Content-Type","application/json");req.Header.Set("Authorization","Bearer "+key);resp,e:=http.DefaultClient.Do(req);if e!=nil{jsonOut(w,502,map[string]string{"error":"provider request failed"});return};defer resp.Body.Close();if v:=resp.Header.Get("Content-Type");v!=""{w.Header().Set("Content-Type",v)};w.WriteHeader(resp.StatusCode);io.Copy(w,resp.Body)
}

func(s *Server)chatAnthropic(w http.ResponseWriter,r *http.Request,model string,messages []map[string]any,maxTokens int,stream bool,base,key string){
 if maxTokens<=0{maxTokens=4096}
 var clean []map[string]string
 for _,m:=range messages{role,_:=m["role"].(string);content:=m["content"];if role=="system"{continue};txt,_:=content.(string);if txt==""{if parts,ok:=content.([]any);ok{var b strings.Builder;for _,p:=range parts{if x,ok:=p.(map[string]any);ok{if t,_:=x["text"].(string);t!=""{b.WriteString(t)}}};txt=b.String()}};if role=="user"||role=="assistant"{clean=append(clean,map[string]string{"role":role,"content":txt})}}
 payload:=map[string]any{"model":model,"max_tokens":maxTokens,"messages":clean,"stream":stream};raw,_:=json.Marshal(payload)
 req,e:=http.NewRequestWithContext(r.Context(),"POST",strings.TrimRight(base,"/")+"/messages",strings.NewReader(string(raw)));if e!=nil{jsonOut(w,502,map[string]string{"error":"request failed"});return};req.Header.Set("Content-Type","application/json");req.Header.Set("x-api-key",key);req.Header.Set("anthropic-version","2023-06-01")
 resp,e:=http.DefaultClient.Do(req);if e!=nil{jsonOut(w,502,map[string]string{"error":"provider request failed"});return};defer resp.Body.Close()
 if stream{if v:=resp.Header.Get("Content-Type");v!=""{w.Header().Set("Content-Type",v)};w.WriteHeader(resp.StatusCode);io.Copy(w,resp.Body);return}
 data,_:=io.ReadAll(resp.Body);if resp.StatusCode<200||resp.StatusCode>=300{w.Header().Set("Content-Type","application/json");w.WriteHeader(resp.StatusCode);w.Write(data);return}
 var a struct{ID string `json:"id"`;Content []struct{Text string `json:"text"`} `json:"content"`;Model string `json:"model"`;Usage struct{Input int `json:"input_tokens"`;Output int `json:"output_tokens"`} `json:"usage"`}
 if json.Unmarshal(data,&a)!=nil{jsonOut(w,502,map[string]string{"error":"invalid anthropic response"});return}
 var text strings.Builder;for _,p:=range a.Content{text.WriteString(p.Text)}
 out:=map[string]any{"id":a.ID,"object":"chat.completion","created":time.Now().Unix(),"model":a.Model,"choices":[]any{map[string]any{"index":0,"message":map[string]any{"role":"assistant","content":text.String()},"finish_reason":"stop"}},"usage":map[string]any{"prompt_tokens":a.Usage.Input,"completion_tokens":a.Usage.Output,"total_tokens":a.Usage.Input+a.Usage.Output}}
 jsonOut(w,200,out)
}

func jsonOut(w http.ResponseWriter,status int,v any){w.Header().Set("Content-Type","application/json");w.WriteHeader(status);json.NewEncoder(w).Encode(v)}
func logging(next http.Handler)http.Handler{return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){st:=time.Now();next.ServeHTTP(w,r);log.Printf("%s %s %s",r.Method,r.URL.Path,time.Since(st))})}
